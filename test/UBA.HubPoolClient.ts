import { random } from "lodash";
// import { PendingRootBundle } from "../../src/interfaces";
import { UBAClient } from "../src/utils";
import {
  BigNumber,
  Contract,
  createSpyLogger,
  deploySpokePool,
  expect,
  ethers,
  hubPoolFixture,
  // SignerWithAddress,
  toBN,
  toBNWei,
} from "./utils";
import { MockHubPoolClient, MockSpokePoolClient } from "./mocks";

type Event = ethers.Event;

let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
let hubPool: Contract, dai: Contract, weth: Contract;
let uba: UBAClient;
let hubPoolClient: MockHubPoolClient;
let hubPoolDeploymentBlock: number;

const logger = createSpyLogger().spyLogger;

const chainIds = [10, 137];

describe("UBA: HubPool Events", async function () {
  beforeEach(async function () {
    ({ hubPool, dai, weth } = await hubPoolFixture());
    hubPoolDeploymentBlock = random(1, 100, false);
    hubPoolClient = new MockHubPoolClient(logger, hubPool, hubPoolDeploymentBlock);
    await hubPoolClient.update();

    spokePoolClients = {};
    for (const originChainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, originChainId, deploymentBlock);
      spokePoolClients[originChainId] = spokePoolClient;

      // Register deposit routes in HubPool and SpokePools.
      // Note: Each token uses the same address across all chains.
      const otherChainIds = chainIds.filter((otherChainId) => otherChainId !== originChainId);
      for (const destinationChainId of otherChainIds) {
        [dai.address, weth.address].forEach((originToken) => {
          let event = spokePoolClient.generateDepositRoute(originToken, destinationChainId, true);
          spokePoolClient.addEvent(event);

          event = hubPoolClient.setPoolRebalanceRoute(originChainId, originToken, originToken);
          hubPoolClient.addEvent(event);
        });
      }
    }

    uba = new UBAClient(chainIds, hubPoolClient, spokePoolClients);

    await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
    await hubPoolClient.update();
  });

  it("Defaults to deployment block when no root bundles have been executed", async function () {
    for (const chainId of chainIds) {
      for (const token of [weth.address, dai.address]) {
        const { balance, blockNumber } = uba.getOpeningBalance(chainId, token);
        expect(balance.eq(0)).to.be.true;
        expect(blockNumber).to.be.equal(hubPoolDeploymentBlock);
      }
    }
  });

  it("Correctly identifies updated opening balances", async function () {
    let bundleEvaluationBlockNumbers: BigNumber[] = [];

    // Simulate leaf execution.
    const leafEvents: Event[] = [];
    for (let i = 0; i < 3; ++i) {
      bundleEvaluationBlockNumbers = Object.values(spokePoolClients).map((spokePoolClient) =>
        toBN(spokePoolClient.latestBlockNumber)
      );

      const rootBundleProposal = hubPoolClient.proposeRootBundle(
        Math.floor(Date.now() / 1000) - 1, // challengePeriodEndTimestamp
        chainIds.length, // poolRebalanceLeafCount
        bundleEvaluationBlockNumbers
      );
      hubPoolClient.addEvent(rootBundleProposal);
      await hubPoolClient.update();

      let leafId = 0;
      chainIds.forEach((chainId) => {
        const groupIndex = toBN(chainId === hubPoolClient.chainId ? 0 : 1);
        const leafEvent = hubPoolClient.executeRootBundle(
          groupIndex,
          leafId++,
          toBN(chainId),
          [dai.address], // l1Tokens
          [toBNWei(0)], // bundleLpFees
          [toBNWei(0)], // netSendAmounts
          [toBNWei(random(-1000, 1000).toPrecision(5))] // runningBalances
        );
        leafEvents.push(leafEvent);
        hubPoolClient.addEvent(leafEvent);
      });

      await hubPoolClient.update();
      await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));
    }

    for (const chainId of chainIds) {
      // DAI has executed leaves, WETH does not (running balance should default to 0).
      for (const token of [dai.address, weth.address]) {
        const { balance, blockNumber } = uba.getOpeningBalance(chainId, token);

        // Find the last executed leaf affecting `token` on this chain. If no leaf affecting `token`
        // has ever been executed, default tokenIdx to -1 to indicate an expected runningBalance of 0.
        const event = Array.from(leafEvents)
          .reverse()
          .find((event) => event["args"]["chainId"].eq(chainId) && event["args"]["l1Tokens"].includes(token));
        const tokenIdx = event ? event["args"]["l1Tokens"].indexOf(token) : -1;

        const expectedBalance = tokenIdx === -1 ? toBN(0) : event["args"]["runningBalances"][tokenIdx];
        expect(balance.eq(expectedBalance)).to.be.true;

        const chainIdx = chainIds.indexOf(chainId);
        expect(bundleEvaluationBlockNumbers[chainIdx].eq(blockNumber - 1)).to.be.true;
      }
    }
  });
});
