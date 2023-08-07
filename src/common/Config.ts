import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
import { assert } from "../utils";
import * as Constants from "./Constants";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class CommonConfig {
  readonly hubPoolChainId: number;
  readonly pollingDelay: number;
  readonly maxBlockLookBack: { [key: number]: number };
  readonly maxTxWait: number;
  readonly spokePoolChainsOverride: number[];
  readonly sendingTransactionsEnabled: boolean;
  readonly bundleRefundLookback: number;
  readonly maxRelayerLookBack: number;
  readonly version: string;
  readonly maxConfigVersion: number;
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };

  // State we'll load after we update the config store client and fetch all chains we want to support.
  public multiCallChunkSize: { [chainId: number]: number };
  public toBlockOverride: Record<number, number> = {};

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      BLOCK_RANGE_END_BLOCK_BUFFER,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      BUNDLE_REFUND_LOOKBACK,
      SPOKE_POOL_CHAINS_OVERRIDE,
      ACROSS_BOT_VERSION,
      ACROSS_MAX_CONFIG_VERSION,
    } = env;

    this.version = ACROSS_BOT_VERSION ?? "unknown";

    // Maximum version of the Across ConfigStore version that is supported.
    // Operators should normally use the defaults here, but it can be overridden for testing.
    // Warning: Possible loss of funds if this is misconfigured.
    this.maxConfigVersion = Number(ACROSS_MAX_CONFIG_VERSION ?? Constants.CONFIG_STORE_VERSION);
    assert(!isNaN(this.maxConfigVersion), `Invalid maximum config version: ${this.maxConfigVersion}`);

    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : Constants.BUNDLE_END_BLOCK_BUFFERS;

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = Number(MAX_RELAYER_DEPOSIT_LOOK_BACK ?? Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK);
    this.hubPoolChainId = Number(HUB_CHAIN_ID ?? 1);
    this.pollingDelay = Number(POLLING_DELAY ?? 60);
    this.spokePoolChainsOverride = SPOKE_POOL_CHAINS_OVERRIDE ? JSON.parse(SPOKE_POOL_CHAINS_OVERRIDE) : [];
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length === 0) {
      this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    }
    this.maxTxWait = Number(MAX_TX_WAIT_DURATION ?? 180); // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";
    this.bundleRefundLookback = Number(BUNDLE_REFUND_LOOKBACK ?? 2);
  }

  /**
   * @notice Loads additional configuration state that can only be known after we know all chains that we're going to
   * support. Throws an error if any of the configurations are not valid.
   * @dev This should be called by passing in the latest chain ID indices from an updated ConfigStoreClient.
   * @param chainIdIndices All expected chain ID's that could be supported by this config.
   */
  loadAndValidateConfigForChains(chainIdIndices: number[]): void {
    const multiCallChunkSize: { [chainId: number]: number } = {};

    for (const chainId of chainIdIndices) {
      // Validate that there is a block range end block buffer for each chain.
      if (Object.keys(this.blockRangeEndBlockBuffer).length > 0) {
        assert(
          Object.keys(this.blockRangeEndBlockBuffer).includes(chainId.toString()),
          "BLOCK_RANGE_END_BLOCK_BUFFER missing networks"
        );
      }

      // Validate that there is a max block look back for each chain.
      if (Object.keys(this.maxBlockLookBack).length > 0) {
        assert(Object.keys(this.maxBlockLookBack).includes(chainId.toString()), "MAX_BLOCK_LOOK_BACK missing networks");
      }

      // Multicall chunk size precedence: Environment, chain-specific config, global default.
      // prettier-ignore
      const chunkSize = Number(
      process.env[`MULTICALL_CHUNK_SIZE_CHAIN_${chainId}`]
        ?? DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE[chainId]
        ?? DEFAULT_MULTICALL_CHUNK_SIZE
    );
      assert(chunkSize > 0, `Chain ${chainId} multicall chunk size (${chunkSize}) must be greater than 0`);
      multiCallChunkSize[chainId] = chunkSize;

      // Load any toBlock overrides.
      if (process.env[`TO_BLOCK_OVERRIDE_${chainId}`] !== undefined) {
        const toBlock = Number(process.env[`TO_BLOCK_OVERRIDE_${chainId}`]);
        assert(toBlock > 0, `TO_BLOCK_OVERRIDE_${chainId} must be greater than 0`);
        this.toBlockOverride[chainId] = toBlock;
      }
    }

    this.multiCallChunkSize = multiCallChunkSize;
  }
}
