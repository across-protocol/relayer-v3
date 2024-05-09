import { BigNumber, bnZero, winston, DefaultLogLevels, AnyObject } from "../../utils";
import { AdapterManager } from "./AdapterManager";
import { OutstandingTransfers } from "../../interfaces";

type OutstandingCrossChainResponse<Result> = {
  total: Result;
  breakdown: {
    [l2Token: string]: Result;
  };
};

export class CrossChainTransferClient {
  private outstandingCrossChainTransfers: { [chainId: number]: OutstandingTransfers } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly chainIdList: number[],
    readonly adapterManager: AdapterManager
  ) {}

  /**
   * Retrieves the total amount of outstanding cross-chain transfers for a given address.
   * @param address The address to check for outstanding transfers.
   * @param chainId The chainId to check for outstanding transfers.
   * @param l1Token The L1 token to check for outstanding transfers.
   * @param l2Token The L2 token to check for outstanding transfers - If not provided, the sum of all l2Tokens will be returned.
   * @returns The total amount of outstanding cross-chain transfers for the given address.
   */
  getOutstandingCrossChainTransferAmount(
    address: string,
    chainId: number | string,
    l1Token: string,
    l2Token?: string
  ): OutstandingCrossChainResponse<BigNumber> {
    const transfers = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token];
    if (!transfers) {
      return { total: bnZero, breakdown: {} };
    }

    if (l2Token) {
      const totalAmount = transfers[l2Token]?.totalAmount ?? bnZero;
      return {
        total: totalAmount,
        breakdown: {
          [l2Token]: totalAmount,
        },
      };
    }

    // No specific l2Token specified; return the sum of all l1Token transfers to chainId.
    return Object.entries(transfers).reduce(
      (acc, [l2Token, { totalAmount }]) => ({
        total: acc.total.add(totalAmount),
        breakdown: {
          ...acc.breakdown,
          [l2Token]: totalAmount,
        },
      }),
      {
        total: bnZero,
        breakdown: {},
      }
    );
  }

  /**
   * Retrieves the tx hashes of outstanding cross-chain transfers for a given address.
   * @param address The address to check for outstanding transfers.
   * @param chainId The chainId to check for outstanding transfers.
   * @param l1Token The L1 token to check for outstanding transfers.
   * @param l2Token The L2 token to check for outstanding transfers - If not provided, the sum of all l2Tokens will be returned.
   * @returns The tx hashes of outstanding cross-chain transfers for the given address.
   */
  getOutstandingCrossChainTransferTxs(
    address: string,
    chainId: number | string,
    l1Token: string,
    l2Token?: string
  ): OutstandingCrossChainResponse<string[]> {
    const transfers = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token];
    if (!transfers) {
      return { total: [], breakdown: {} };
    }

    if (l2Token) {
      const depositTxHashes = transfers[l2Token]?.depositTxHashes ?? [];
      return {
        total: depositTxHashes,
        breakdown: {
          [l2Token]: depositTxHashes,
        },
      };
    }

    // No specific l2Token specified; return the set of all l1Token transfers to chainId.
    return Object.entries(transfers).reduce(
      (acc, [l2Token, { depositTxHashes }]) => ({
        total: [...acc.total, ...depositTxHashes],
        breakdown: {
          ...acc.breakdown,
          [l2Token]: depositTxHashes,
        },
      }),
      {
        total: [],
        breakdown: {},
      }
    );
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    return this.getEnabledChains().filter((chainId) => chainId !== 1);
  }

  increaseOutstandingTransfer(
    address: string,
    l1Token: string,
    l2Token: string,
    rebalance: BigNumber,
    chainId: number
  ): void {
    const transfers = (this.outstandingCrossChainTransfers[chainId] ??= {});
    transfers[address] ??= {};
    transfers[address][l1Token] ??= {};
    transfers[address][l1Token][l2Token] ??= { totalAmount: bnZero, depositTxHashes: [] };

    // TODO: Require a tx hash here so we can track it as well.
    transfers[address][l1Token][l2Token].totalAmount = this.getOutstandingCrossChainTransferAmount(
      address,
      chainId,
      l1Token,
      l2Token
    ).total.add(rebalance);
  }

  async update(l1Tokens: string[]): Promise<void> {
    const monitoredChains = this.getEnabledL2Chains(); // Use all chainIds except L1.
    this.log("Updating cross chain transfers", { monitoredChains });

    const outstandingTransfersPerChain = await Promise.all(
      monitoredChains.map(async (chainId) => [
        chainId,
        await this.adapterManager.getOutstandingCrossChainTokenTransferAmount(chainId, l1Tokens),
      ])
    );
    this.outstandingCrossChainTransfers = Object.fromEntries(outstandingTransfersPerChain);
    this.log("Updated cross chain transfers", { outstandingCrossChainTransfers: this.outstandingCrossChainTransfers });
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "CrossChainTransferClient", message, ...data });
    }
  }
}
