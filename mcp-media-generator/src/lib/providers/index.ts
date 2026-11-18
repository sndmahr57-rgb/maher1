// سجل المزودات المفعّلة — يستخدمه منسّق التوليد بالترتيب
import type { ProviderId } from "../models";
import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};
