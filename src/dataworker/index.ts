import { processEndPollingLoop, winston, config, startupLogLevel, Wallet } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
config();
let logger: winston.Logger;

export async function createDataworker(_logger: winston.Logger, baseSigner: Wallet) {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config, baseSigner);

  const dataworker = new Dataworker(
    _logger,
    clients,
    Constants.CHAIN_ID_LIST_INDICES,
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.tokenTransferThresholdOverride,
    config.blockRangeEndBlockBuffer,
    config.spokeRootsLookbackCount,
    config.bufferToPropose
  );

  return {
    config,
    clients,
    dataworker,
  };
}
export async function runDataworker(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;

  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

  try {
    for (;;) {
      const loopStart = Date.now();
      await updateDataworkerClients(clients);
      // Caller can optionally override the disabled chains list, which is useful for executing leaves or validating
      // older bundles. The Caller should be careful when setting when running the disputer or proposer functionality
      // as it can lead to proposing disputable bundles or disputing valid bundles.
      const disabledChains = config.disabledChainsOverride ?? clients.configStoreClient.getDisabledChainsForBlock();
      const configWithDisabledChains = {
        ...config,
        spokePoolChains: config.spokePoolChains.filter((chainId) => !disabledChains.includes(chainId)),
      };
      logger.debug({
        at: "Dataworker#index",
        message: "Disabled chains listed in config store",
        disabledChains,
      });

      // Determine the spoke client's lookback:
      // 1. We initiate the spoke client event search windows based on a start bundle's bundle block end numbers and
      //    how many bundles we want to look back from the start bundle blocks.
      // 2. For example, if the start bundle is 100 and the lookback is 16, then we will set the spoke client event
      //    search window's toBlocks equal to the 100th bundle's block evaluation numbers and the fromBlocks equal
      //    to the 84th bundle's block evaluation numbers.
      // 3. Once we do all the querying, we figure out the earliest block that we’re able to validate per chain. This
      //    is simply equal to the first block queried per chain.
      // 4. If the earliest block we can validate is later than some target fully executed bundle's start blocks,
      //    then extend the SpokePoolClients' lookbacks and update again. Do this up to a specified # of retries.
      //    By dynamically increasing the range of Deposit events to at least cover the target bundle's
      //    start blocks, we can reduce the error rate. This is because of how the disputer and proposer will handle
      //    the case where it can't validate a fill without loading an earlier block.
      // 5. If the bundle we’re trying to validate or propose requires an earlier block, then exit early and
      //    emit an alert. In the dispute flow, this alert should be ERROR level.

      // Get block range for spoke clients using the dataworker fast lookback bundle count.
      const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
        configWithDisabledChains,
        clients,
        dataworker
      );
      logger.debug({
        at: "Dataworker#index",
        message:
          "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
        dataworkerFastStartBundle: config.dataworkerFastStartBundle,
        dataworkerFastLookbackCount: config.dataworkerFastLookbackCount,
        fromBlocks,
        toBlocks,
        fromBundleTxn: fromBundle?.transactionHash,
        toBundleTxn: toBundle?.transactionHash,
      });
      const spokePoolClients = await constructSpokePoolClientsForFastDataworker(
        logger,
        clients.configStoreClient,
        configWithDisabledChains,
        baseSigner,
        fromBlocks,
        toBlocks
      );

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled)
        await dataworker.validatePendingRootBundle(spokePoolClients, config.sendingDisputesEnabled, fromBlocks);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled,
          fromBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          fromBlocks
        );

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          fromBlocks
        );
        await dataworker.executeRelayerRefundLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          fromBlocks
        );
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue();

      logger.debug({ at: "Dataworker#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (clients.configStoreClient.redisClient !== undefined) {
      // todo understand why redisClient isn't GCed automagically.
      logger.debug("Disconnecting from redis server.");
      clients.configStoreClient.redisClient.disconnect();
    }

    throw error;
  }
}
