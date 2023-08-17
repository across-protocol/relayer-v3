import {
  Contract,
  BigNumber,
  ZERO_ADDRESS,
  paginatedEventQuery,
  Event,
  Signer,
  EventSearchConfig,
  Provider,
} from "../../../utils";
import { CONTRACT_ADDRESSES } from "../../../common";
import { BridgeTransactionDetails, OpStackBridge } from "./OpStackBridgeInterface";

export class DefaultERC20Bridge implements OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(private l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  get l1Gateway(): string {
    return this.l1Bridge.address;
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails {
    return {
      contract: this.l1Bridge,
      method: "depositERC20",
      args: [l1Token, l2Token, amount, l2Gas, "0x"],
    };
  }

  queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.ERC20DepositInitiated(undefined, fromAddress),
      eventConfig
    );
  }

  queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.DepositFinalized(ZERO_ADDRESS, undefined, fromAddress),
      eventConfig
    );
  }
}
