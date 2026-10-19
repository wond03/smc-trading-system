/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as candles from "../candles.js";
import type * as custody from "../custody.js";
import type * as indicators from "../indicators.js";
import type * as liquidity from "../liquidity.js";
import type * as notify from "../notify.js";
import type * as records from "../records.js";
import type * as reports from "../reports.js";
import type * as reportsStats from "../reportsStats.js";
import type * as risk from "../risk.js";
import type * as scanner from "../scanner.js";
import type * as signalEngine from "../signalEngine.js";
import type * as signalRunner from "../signalRunner.js";
import type * as types from "../types.js";
import type * as weex from "../weex.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  candles: typeof candles;
  custody: typeof custody;
  indicators: typeof indicators;
  liquidity: typeof liquidity;
  notify: typeof notify;
  records: typeof records;
  reports: typeof reports;
  reportsStats: typeof reportsStats;
  risk: typeof risk;
  scanner: typeof scanner;
  signalEngine: typeof signalEngine;
  signalRunner: typeof signalRunner;
  types: typeof types;
  weex: typeof weex;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
