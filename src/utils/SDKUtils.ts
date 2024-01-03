import * as sdk from "@across-protocol/sdk-v2";

export class BlockFinder extends sdk.utils.BlockFinder {}
export type BlockFinderHints = sdk.utils.BlockFinderHints;

export class PriceClient extends sdk.priceClient.PriceClient {}
export const { acrossApi, coingecko, defiLlama } = sdk.priceClient.adapters;

export type InvalidFillEnum = sdk.utils.InvalidFill;

export const {
  bnZero,
  bnOne,
  bnUint32Max,
  bnUint256Max,
  chainIsOPStack,
  fixedPointAdjustment,
  toBN,
  bnToHex,
  toWei,
  toGWei,
  toBNWei,
  formatFeePct,
  InvalidFill,
  shortenHexStrings,
  convertFromWei,
  max,
  min,
  utf8ToHex,
  createFormatFunction,
  fromWei,
  blockExplorerLink,
  blockExplorerLinks,
  createShortHexString: shortenHexString,
} = sdk.utils;
