import { logger } from "@truffle/db/logger";
const debug = logger("db:project:migrate:networkGenealogies");

import gql from "graphql-tag";
import {
  IdObject,
  toIdObject,
  resources,
  Process
} from "@truffle/db/project/process";

/**
 * Load NetworkGenealogy records for a given set of artifacts while connected
 * to a blockchain with a provider.
 *
 * This operates on a batch of artifacts, each of which may define a network
 * object for the currently connected chain. As part of the Project.loadMigrate
 * workflow, this process function requires artifact networks to be passed with
 * historic block information and a reference to the Network.
 *
 * We take, as a precondition, that all relevant artifact networks are actually
 * part of the same blockchain; i.e., that artifact networks represented by
 * later blocks do in fact descend from artifact networks represented by
 * earlier blocks.
 *
 * Using this assumption, the process is as follows:
 *
 *   1. Map + filter artifacts into artifact networks, excluding any unrelated
 *      artifact networks in each artifact.
 *
 *   2. Sort these artifact networks by block height.
 *
 *   3. For each pair of artifact networks in the sorted list, generate a
 *      corresponding NetworkGenealogyInput whose ancestor/descendant are
 *      Networks from the earlier/later item in the pair, respectively.
 *
 *   4. Connect this series of network genealogy records with existing
 *      genealogy records in the system by querying for:
 *        (a) the closest known ancestor to our earliest given network, and
 *            (the "ancestor ancestor")
 *        (b) the closest known descendant to our latest given network
 *            ("the descendant descandant")
 *
 *   5. If either/both relations exist from step 4, extend our collection of
 *      NetworkGenealogyInputs from step 3 with a corresponding
 *      NetworkGenealogyInput for each such relation
 *
 *   6. Load all inputs as NetworkGenealogy resources
 *
 * Note: unlike other process functions in the larger Project.loadMigrate flow,
 * this does not use the batch abstraction, and thus does not return structured
 * data in the original input form. Although this function returns a list of
 * NetworkGenealogy ID objects, it is likely not necessary to capture this
 * information anywhere, and thus the return value can likely be discarded.
 */
export function* generateNetworkGenealogiesLoad<
  ArtifactNetwork extends {
    block?: DataModel.Block;
    db?: {
      network: IdObject<DataModel.Network>;
    };
  }
>(options: {
  network: { networkId };
  artifacts: {
    networks?: {
      [networkId: string]: ArtifactNetwork | undefined;
    };
  }[];
}): Process<IdObject<DataModel.NetworkGenealogy>[]> {
  const {
    artifacts,
    network: { networkId }
  } = options;

  // grab only the artifact networks for our currently connected networkId
  // and map to the artifact network itself
  const artifactNetworks = artifacts
    .filter(({ networks }) => networks && networks[networkId])
    .map(({ networks }) => networks[networkId]);

  // for all such artifact networks, find the earliest/latest and generate
  // NetworkGenealogyInputs for all pairs.
  const {
    ancestor,
    descendant,
    networkGenealogies
  } = collectArtifactNetworks(artifactNetworks);
  debug("networkGenealogies %o", networkGenealogies);

  // look for possible ancestor of the earliest network, convert to
  // NetworkGenealogyInput if it exists
  const ancestorAncestor = yield* findRelation("ancestor", ancestor);
  debug("ancestorAncestor %o", ancestorAncestor);
  if (ancestorAncestor) {
    networkGenealogies.push({
      ancestor: ancestorAncestor,
      descendant: ancestor
    });
  }

  // look for possible descendant of the latest network, convert to
  // NetworkGenealogyInput if it exists
  const descendantDescendant = yield* findRelation("descendant", descendant);
  debug("descendantDescendant %o", descendantDescendant);
  if (descendantDescendant) {
    networkGenealogies.push({
      ancestor: descendant,
      descendant: descendantDescendant
    });
  }

  // load all NetworkGenealogyInputs
  return yield* resources.load("networkGenealogies", networkGenealogies);
}

interface CollectArtifactNetworksResult {
  ancestor: IdObject<DataModel.Network>;
  descendant: IdObject<DataModel.Network>;
  networkGenealogies: DataModel.NetworkGenealogyInput[];
}

/**
 * Given a sparsely-populated list of artifact networks from the same
 * blockchain, find the earliest/latest Network from this list (as ancestor/
 * descendant, respectively) and create pairwise NetworkGenealogyInputs
 * for all Networks in between.
 *
 * Returns undefined for a list with no non-null inputs.
 *
 * Returns ancestor === descendant for a list with only one unique input
 */
function collectArtifactNetworks<
  ArtifactNetwork extends {
    block?: DataModel.Block;
    db?: {
      network: IdObject<DataModel.Network>;
    };
  }
>(
  artifactNetworks: (ArtifactNetwork | undefined)[]
): CollectArtifactNetworksResult | undefined {
  // start by ordering non-null networks by block height
  // map to reference to Network itself
  const networks: IdObject<DataModel.Network>[] = artifactNetworks
    .filter(
      ({ block, db: { network } = {} } = {} as ArtifactNetwork) => block && network
    )
    .sort((a, b) => a.block.height - b.block.height)
    .map(({ db: { network } }) => network);

  // handle all-null case
  if (networks.length < 1) {
    return;
  }

  // for our reduction, we'll need to keep track of the current ancestor for
  // each pair as we step over the descendants for each pair.
  type ResultAccumulator = Omit<CollectArtifactNetworksResult, "descendant">;

  const initialAccumulator: ResultAccumulator = {
    ancestor: networks[0],
    networkGenealogies: []
  };

  // starting after the first ancestor, reduce over each subsequent Network
  // to construct pairwise NetworkGenealogyInputs
  const { networkGenealogies } = networks.slice(1).reduce(
    (
      { ancestor, networkGenealogies }: ResultAccumulator,
      descendant: IdObject<DataModel.Network>
    ): ResultAccumulator => ({
      ancestor: descendant,
      networkGenealogies: [...networkGenealogies, { ancestor, descendant }]
    }),
    initialAccumulator
  );

  // and finally return these inputs alongside the known ancestor/descendant
  // (these may be the same)
  return {
    ancestor: networks[0], // first
    descendant: networks.slice(-1)[0], //last
    networkGenealogies
  };
};

/**
 * Issue GraphQL requests and eth_getBlockByNumber requests to determine if any
 * existing Network resources are ancestor or descendant of the connected
 * Network.
 *
 * Iteratively, this queries all possibly-related Networks for known historic
 * block. For each possibly-related Network, issue a corresponding web3 request
 * to determine if the known historic block is, in fact, the connected
 * blockchain's record of the block at that historic height.
 *
 * This queries @truffle/db for possibly-related Networks in batches, keeping
 * track of new candidates vs. what has already been tried.
 */
function* findRelation(
  relation: "ancestor" | "descendant",
  network: IdObject<DataModel.Network>
): Process<IdObject<DataModel.Network | undefined>> {
  // determine GraphQL query to invoke based on requested relation
  const query =
    relation === "ancestor" ? "possibleAncestors" : "possibleDescendants";

  // since we're doing this iteratively, keep track of what networks we've
  // tried and which ones we haven't
  let alreadyTried: string[] = [];
  let candidates: DataModel.Network[];

  do {
    // query graphql for new candidates
    ({
      networks: candidates,
      alreadyTried
    } = yield* queryNextPossiblyRelatedNetworks(
      relation,
      network,
      alreadyTried
    ));

    // check blockchain to first a matching network
    const matchingCandidate: IdObject<DataModel.Network> | undefined =
      yield* findMatchingCandidateOnChain(candidates);

    if (matchingCandidate) {
      return matchingCandidate;
    }
  } while (candidates.length > 0);

  // otherwise we got nothin'
}

/**
 * Issue GraphQL queries for possibly-related networks.
 *
 * This is called repeatedly, passing the resulting `alreadyTried` to the next
 * invocation.
 */
function* queryNextPossiblyRelatedNetworks(
  relation: "ancestor" | "descendant",
  network: IdObject<DataModel.Network>,
  alreadyTried: string[]
): Process<DataModel.CandidateSearchResult> {
  // determine GraphQL query to invoke based on requested relation
  const query =
    relation === "ancestor" ? "possibleAncestors" : "possibleDescendants";
  debug("finding %s", query);

  // query graphql for new candidates
  let result;
  try {
    ({
      [query]: result
    } = yield* resources.get(
      "networks",
      network.id,
      gql`
        fragment Possible_${relation}s on Network {
          ${query}(alreadyTried: ${JSON.stringify(alreadyTried)}) {
            networks {
              id
              historicBlock {
                hash
                height
              }
            }
            alreadyTried {
              id
            }
          }
        }
      `
    ));
  } catch (error) {
    debug("error %o", error);
  }

  debug("candidate networks %o", result.networks);
  return result;
}

/**
 * Issue web3 requests for a list of candidate Networks to determine
 * if any of their historic blocks are present in the connected blockchain.
 *
 * This works by querying for block hashes for given candidate heights
 */
function* findMatchingCandidateOnChain(
  candidates: DataModel.Network[]
): Process<IdObject<DataModel.Network> | undefined> {
  for (const candidate of candidates) {
    const response = yield {
      type: "web3",
      method: "eth_getBlockByNumber",
      params: [candidate.historicBlock.height, false]
    };

    // return if we have a result
    if (
      response &&
      response.result &&
      response.result.hash === candidate.historicBlock.hash
    ) {
      return toIdObject(candidate);
    }
  }
}