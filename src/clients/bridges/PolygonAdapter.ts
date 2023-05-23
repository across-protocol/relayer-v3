import {
  runTransaction,
  assign,
  Contract,
  BigNumber,
  bnToHex,
  winston,
  Event,
  isDefined,
  BigNumberish,
  TransactionResponse,
} from "../../utils";
import { ZERO_ADDRESS, spreadEventWithBlockNumber, paginatedEventQuery } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter, polygonL1BridgeInterface, polygonL2BridgeInterface } from "./";
import { polygonL1RootChainManagerInterface, atomicDepositorInterface } from "./";
import { SortableEvent } from "../../interfaces";
import { constants } from "@across-protocol/sdk-v2";
import { OutstandingTransfers } from "../../interfaces";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = constants;

// ether bridge = 0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30
// erc20 bridge = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf
// matic bridge = 0x401f6c983ea34274ec46f84d70b31c151321188b

// When bridging ETH to Polygon we MUST send ETH which is then wrapped in the bridge to WETH. We are unable to send WETH
// directly over the bridge, just like in the Optimism/Boba cases.

const l1RootChainManager = "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77";

const tokenToBridge = {
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // USDC
  [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // USDT
  [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // DAI
  [TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // WBTC
  [TOKEN_SYMBOLS_MAP.UMA.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.UMA.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // UMA
  [TOKEN_SYMBOLS_MAP.BADGER.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.BADGER.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // BADGER
  [TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // BAL
  [TOKEN_SYMBOLS_MAP.ACX.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.ACX.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // ACX
  [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedEther",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // WETH
  [TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x401f6c983ea34274ec46f84d70b31c151321188b",
    l2TokenAddress: ZERO_ADDRESS,
    l1Method: "NewDepositBlock",
    l1AmountProp: "amountOrNFTId",
    l2AmountProp: "amount",
  }, // MATIC
} as const;

type SupportedL1Token = string;

const atomicDepositorAddress = "0x26eaf37ee5daf49174637bdcd2f7759a25206c34";

export class PolygonAdapter extends BaseAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, 137, monitoredAddresses, logger);
  }

  // On polygon a bridge transaction looks like a transfer from address(0) to the target.
  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    const promises: Promise<Event[]>[] = [];
    const validTokens: SupportedL1Token[] = [];
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of l1Tokens) {
        // Skip the token if we can't find the corresponding bridge.
        // This is a valid use case as it's more convenient to check cross chain transfers for all tokens
        // rather than maintaining a list of native bridge-supported tokens.
        if (!this.isSupportedToken(l1Token)) {
          continue;
        }

        const l1Bridge = this.getL1Bridge(l1Token);
        const l2Token = this.getL2Token(l1Token);

        const l1Method = tokenToBridge[l1Token].l1Method;
        let l1SearchFilter: (string | undefined)[] = [];
        if (l1Method === "LockedERC20") {
          l1SearchFilter = [monitoredAddress, undefined, l1Token];
        }
        if (l1Method === "LockedEther") {
          l1SearchFilter = [undefined, monitoredAddress];
        }
        if (l1Method === "NewDepositBlock") {
          l1SearchFilter = [monitoredAddress, TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET]];
        }

        const l2Method =
          l1Token === TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET] ? "TokenDeposited" : "Transfer";
        let l2SearchFilter: (string | undefined)[] = [];
        if (l2Method === "Transfer") {
          l2SearchFilter = [ZERO_ADDRESS, monitoredAddress];
        }
        if (l2Method === "TokenDeposited") {
          l2SearchFilter = [TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET], ZERO_ADDRESS, monitoredAddress];
        }

        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), l1SearchConfig),
          paginatedEventQuery(l2Token, l2Token.filters[l2Method](...l2SearchFilter), l2SearchConfig)
        );
        validTokens.push(l1Token);
      }
    }

    const results = await Promise.all(promises);

    // 2 events per token.
    const numEventsPerMonitoredAddress = 2 * validTokens.length;

    // Segregate the events list by monitored address.
    const resultsByMonitoredAddress = Object.fromEntries(
      this.monitoredAddresses.map((monitoredAddress, index) => {
        const start = index * numEventsPerMonitoredAddress;
        return [monitoredAddress, results.slice(start, start + numEventsPerMonitoredAddress + 1)];
      })
    );

    // Process events for each monitored address.
    for (const monitoredAddress of this.monitoredAddresses) {
      const eventsToProcess = resultsByMonitoredAddress[monitoredAddress];
      eventsToProcess.forEach((result, index) => {
        const l1Token = validTokens[Math.floor(index / 2)];
        const amountProp = index % 2 === 0 ? tokenToBridge[l1Token].l1AmountProp : tokenToBridge[l1Token].l2AmountProp;
        const events = result.map((event) => {
          // Hacky typing here. We should probably rework the structure of this function to improve.
          const eventSpread = spreadEventWithBlockNumber(event) as unknown as SortableEvent & {
            [amount in typeof amountProp]?: BigNumberish;
          } & { depositReceiver: string };
          return {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            amount: eventSpread[amountProp]!,
            to: eventSpread["depositReceiver"],
            ...eventSpread,
          };
        });
        const eventsStorage = index % 2 === 0 ? this.l1DepositInitiatedEvents : this.l2DepositFinalizedEvents;
        assign(eventsStorage, [monitoredAddress, l1Token], events);
      });
    }

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL2SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(validTokens);
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    let method = "depositFor";
    // note that the amount is the bytes 32 encoding of the amount.
    let args = [address, l1Token, bnToHex(amount)];

    // If this token is WETH (the tokenToEvent maps to the ETH method) then we modify the params to deposit ETH.
    if (this.isWeth(l1Token)) {
      method = "bridgeWethToPolygon";
      args = [address, amount.toString()];
    }
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    return await runTransaction(this.logger, this.getL1TokenGateway(l1Token), method, args);
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const associatedL1Bridges = l1Tokens
      .map((l1Token) => {
        if (this.isWeth(l1Token)) {
          return this.getL1TokenGateway(l1Token)?.address;
        }
        if (!this.isSupportedToken(l1Token)) {
          return null;
        }
        return this.getL1Bridge(l1Token).address;
      })
      .filter(isDefined);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: SupportedL1Token): Contract {
    return new Contract(tokenToBridge[l1Token].l1BridgeAddress, polygonL1BridgeInterface, this.getSigner(1));
  }

  getL1TokenGateway(l1Token: string): Contract {
    if (this.isWeth(l1Token)) {
      return new Contract(atomicDepositorAddress, atomicDepositorInterface, this.getSigner(1));
    } else {
      return new Contract(l1RootChainManager, polygonL1RootChainManagerInterface, this.getSigner(1));
    }
  }

  // Note that on polygon we dont query events on the L2 bridge. rather, we look for mint events on the L2 token.
  getL2Token(l1Token: SupportedL1Token): Contract {
    return new Contract(tokenToBridge[l1Token].l2TokenAddress, polygonL2BridgeInterface, this.getSigner(this.chainId));
  }

  private isSupportedToken(l1Token: string): l1Token is SupportedL1Token {
    return l1Token in tokenToBridge;
  }
}
