import type { ProviderConfig } from "@knowself/contracts";
import type { IAdapter } from "./types";
import { ProviderNotFoundError } from "../errors";

export function createCustomAdapter(_config: ProviderConfig): IAdapter {
  throw new ProviderNotFoundError(_config.id);
}
