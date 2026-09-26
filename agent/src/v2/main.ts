// Veilance B-2 — entry point. `VEILANCE_V2_ROLE` picks node, sponsor or both.
//
//   npm run v2                                  # both roles, port 4100
//   VEILANCE_V2_ROLE=sponsor VEILANCE_V2_PORT=4200 npm run v2
//   VEILANCE_V2_ROLE=node VEILANCE_SPONSOR_URL=http://localhost:4200 npm run v2

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { CORS_ORIGINS, V2_PORT, V2_ROLE } from "./config.js";
import { bootNode } from "./node.js";
import { mountNode } from "./routes.js";
import { bootSponsor, mountSponsor } from "./sponsor.js";

const app = new Hono();
app.use("*", cors({ origin: CORS_ORIGINS }));

if (V2_ROLE !== "node") mountSponsor(app);
if (V2_ROLE !== "sponsor") mountNode(app);

serve({ fetch: app.fetch, port: V2_PORT }, (info) => console.log(`Veilance v2 (${V2_ROLE}) listening on http://localhost:${info.port}`));

if (V2_ROLE !== "node") void bootSponsor();
if (V2_ROLE !== "sponsor") void bootNode();
