// Every plugin in the tree (SMD-2310), imported by name. The server reads this
// list and OB1_PLUGINS picks from it (server-portable/core/plugins.ts): a plugin is
// code that runs in the brain's process, so the set it may run is fixed when
// the image is built, never loaded by a name the environment gives. A new
// plugin adds its import and its entry here.

import type { PluginManifest } from "../server-portable/plugin-sdk.ts";
import example from "./example/index.ts";
import familyCalendar from "./family-calendar/index.ts";
import homeMaintenance from "./home-maintenance/index.ts";
import householdKnowledge from "./household-knowledge/index.ts";
import mealPlanning from "./meal-planning/index.ts";
import professionalCrm from "./professional-crm/index.ts";

export const PLUGINS: readonly PluginManifest[] = [example, familyCalendar, homeMaintenance, householdKnowledge, mealPlanning, professionalCrm];
