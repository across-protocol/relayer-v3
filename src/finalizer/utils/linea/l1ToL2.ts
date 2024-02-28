import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { L1MessageServiceContract } from "@consensys/linea-sdk/dist/lib/contracts";
import { TokensRelayedEvent } from "@across-protocol/contracts-v2/dist/typechain/contracts/chain-adapters/Linea_Adapter";
import { Wallet, utils, providers } from "ethers";
import { groupBy } from "lodash";

import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES } from "../../../common";
import { Signer, winston, convertFromWei, TransactionReceipt, paginatedEventQuery } from "../../../utils";
import { FinalizerPromise, CrossChainTransfer } from "../../types";
import { initLineaSdk, makeGetMessagesWithStatusByTxHash, MessageWithStatus, lineaAdapterIface } from "./common";

type ParsedAdapterEvent = {
  parsedLog: utils.LogDescription;
  log: providers.Log;
};

export async function lineaL1ToL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const [l1ChainId, hubPoolAddress] = [hubPoolClient.chainId, hubPoolClient.hubPool.address];
  const l2ChainId = l1ChainId === 1 ? 59144 : 59140;
  const lineaSdk = initLineaSdk(l1ChainId, l2ChainId);
  const l2Contract = lineaSdk.getL2Contract(CONTRACT_ADDRESSES[l2ChainId]?.lineaMessageService.address);
  const l1Contract = lineaSdk.getL1Contract(CONTRACT_ADDRESSES[l1ChainId]?.lineaMessageService.address);
  const getMessagesWithStatusByTxHash = makeGetMessagesWithStatusByTxHash(l1Contract, l2Contract);

  // Get Linea's `MessageSent` events originating from HubPool
  const messageSentEvents = await paginatedEventQuery(
    // l1Contract.contract.connect(hubPoolClient.hubPool.provider),
    l1Contract.contract,
    l1Contract.contract.filters.MessageSent(hubPoolAddress, null, null, null, null, null, null),
    {
      fromBlock: latestBlockToFinalize,
      toBlock: hubPoolClient.latestBlockSearched,
      maxBlockLookBack: 10_000,
    }
  );

  // Get relevant tx receipts
  const txnReceipts = await Promise.all(
    messageSentEvents.map(({ transactionHash }) =>
      hubPoolClient.hubPool.provider.getTransactionReceipt(transactionHash)
    )
  );
  const relevantTxReceipts = filterLineaTxReceipts(txnReceipts, l1Contract);

  // Get relevant Linea_Adapter events, i.e. TokensRelayed, RelayedMessage
  const l1SrcEvents = parseAdapterEventsFromTxReceipts(relevantTxReceipts);

  // Get Linea's MessageSent events with status
  const relevantMessages = (
    await Promise.all(relevantTxReceipts.map(({ transactionHash }) => getMessagesWithStatusByTxHash(transactionHash)))
  ).flat();

  // Merge messages with TokensRelayed/RelayedMessage events
  const mergedMessages = mergeMessagesWithAdapterEvents(relevantMessages, l1SrcEvents);

  // Group messages by status
  const {
    claimed = [],
    claimable = [],
    unknown = [],
  } = groupBy(mergedMessages, ({ message }) => {
    return message.status === OnChainMessageStatus.CLAIMED
      ? "claimed"
      : message.status === OnChainMessageStatus.CLAIMABLE
      ? "claimable"
      : "unknown";
  });

  // Populate txns for claimable messages
  const populatedTxns = await Promise.all(
    claimable.map(async ({ message }) => {
      return l2Contract.contract.populateTransaction.claimMessage(
        message.messageSender,
        message.destination,
        message.fee,
        message.value,
        (signer as Wallet).address,
        message.calldata,
        message.messageNonce
      );
    })
  );
  const multicall3Call = populatedTxns.map((txn) => ({
    target: l2Contract.contractAddress,
    callData: txn.data,
  }));

  // Populate cross chain calls for claimable messages
  const transfers = claimable.flatMap(({ adapterEvent }) => {
    const { name, args } = adapterEvent.parsedLog;

    if (!["TokensRelayed", "MessageRelayed"].includes(name)) {
      return [];
    }

    let crossChainCall: CrossChainTransfer;

    if (name === "MessageRelayed") {
      crossChainCall = {
        originationChainId: l1ChainId,
        destinationChainId: l2ChainId,
        type: "misc",
        miscReason: "lineaClaim:relayMessage",
      };
    } else {
      const [l1Token, , amount] = args as TokensRelayedEvent["args"];
      const { decimals, symbol: l1TokenSymbol } = hubPoolClient.getTokenInfo(l1ChainId, l1Token);
      const amountFromWei = convertFromWei(amount.toString(), decimals);
      crossChainCall = {
        originationChainId: l1ChainId,
        destinationChainId: l2ChainId,
        l1TokenSymbol,
        amount: amountFromWei,
        type: "deposit",
      };
    }

    return crossChainCall;
  });

  logger.debug({
    at: "Finalizer#LineaL1ToL2Finalizer",
    message: `Detected ${mergedMessages.length} relevant messages`,
    statuses: {
      claimed: claimed.length,
      claimable: claimable.length,
      notReceived: unknown.length,
    },
  });

  return { callData: multicall3Call, crossChainTransfers: transfers };
}

function filterLineaTxReceipts(receipts: TransactionReceipt[], l1MessageService: L1MessageServiceContract) {
  const lineaMessageSentEventTopic = l1MessageService.contract.interface.getEventTopic("MessageSent");
  const lineaTxHashes = receipts
    .filter((receipt) => receipt.logs.some((log) => log.topics[0] === lineaMessageSentEventTopic))
    .map((receipt) => receipt.transactionHash);
  const uniqueTxHashes = Array.from(new Set(lineaTxHashes));
  return uniqueTxHashes.map((txHash) => receipts.find((receipt) => receipt.transactionHash === txHash));
}

function parseAdapterEventsFromTxReceipts(receipts: TransactionReceipt[]) {
  const allLogs = receipts.flatMap((receipt) => receipt.logs);
  return allLogs.flatMap((log) => {
    try {
      const parsedLog = lineaAdapterIface.parseLog(log);
      if (!parsedLog || !["TokensRelayed", "MessageRelayed"].includes(parsedLog.name)) {
        return [];
      }
      return { parsedLog, log };
    } catch (e) {
      return [];
    }
  }) as ParsedAdapterEvent[];
}

function mergeMessagesWithAdapterEvents(messages: MessageWithStatus[], adapterEvents: ParsedAdapterEvent[]) {
  const messagesByTxHash = groupBy(messages, ({ txHash }) => txHash);
  const adapterEventsByTxHash = groupBy(adapterEvents, ({ log }) => log.transactionHash);

  const merged: {
    message: MessageWithStatus;
    adapterEvent: ParsedAdapterEvent;
  }[] = [];
  for (const txHash of Object.keys(messagesByTxHash)) {
    const messages = messagesByTxHash[txHash].sort((a, b) => a.logIndex - b.logIndex);
    const adapterEvents = adapterEventsByTxHash[txHash].sort((a, b) => a.log.logIndex - b.log.logIndex);

    if (messages.length !== adapterEvents.length) {
      throw new Error(
        `Mismatched number of MessageSent and TokensRelayed/MessageRelayed events for transaction hash ${txHash}. ` +
          `Found ${messages.length} MessageSent events and ${adapterEvents.length} TokensRelayed/MessageRelayed events.`
      );
    }

    for (const [i, message] of messages.entries()) {
      merged.push({
        message,
        adapterEvent: adapterEvents[i],
      });
    }
  }

  return merged;
}