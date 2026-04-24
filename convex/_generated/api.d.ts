/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _lib_auth from "../_lib/auth.js";
import type * as _lib_constants from "../_lib/constants.js";
import type * as _lib_fileSyncEngine from "../_lib/fileSyncEngine.js";
import type * as _lib_fileSyncProtocol from "../_lib/fileSyncProtocol.js";
import type * as _lib_storage_finalize from "../_lib/storage_finalize.js";
import type * as _lib_validators from "../_lib/validators.js";
import type * as bootstrap from "../bootstrap.js";
import type * as clients from "../clients.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as fileSync from "../fileSync.js";
import type * as http from "../http.js";
import type * as pluginSecretMint from "../pluginSecretMint.js";
import type * as security from "../security.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_lib/auth": typeof _lib_auth;
  "_lib/constants": typeof _lib_constants;
  "_lib/fileSyncEngine": typeof _lib_fileSyncEngine;
  "_lib/fileSyncProtocol": typeof _lib_fileSyncProtocol;
  "_lib/storage_finalize": typeof _lib_storage_finalize;
  "_lib/validators": typeof _lib_validators;
  bootstrap: typeof bootstrap;
  clients: typeof clients;
  crons: typeof crons;
  debug: typeof debug;
  fileSync: typeof fileSync;
  http: typeof http;
  pluginSecretMint: typeof pluginSecretMint;
  security: typeof security;
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
