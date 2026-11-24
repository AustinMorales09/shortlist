// Shortlist's integrations. Importing this module registers the job handlers and the simulators.
import { GCAL, gcal } from "./gcal";
import { GH, greenhouse } from "./greenhouse";
import type { Provider } from "./provider";
import "./sim-gcal";
import "./sim-greenhouse";

export const PROVIDERS: Provider[] = [greenhouse, gcal];
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);
export { GCAL, GH };
