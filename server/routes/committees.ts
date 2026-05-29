import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { committees } from "../../schema/index.js";
import { handleApiError } from "../lib/apiError.js";

export const publicCommitteesRouter = Router();

// â”€â”€â”€ GET /api/committees â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public, no auth. Returns the active committees for the public site so the
// frontend doesn't need to hardcode the list.
publicCommitteesRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id: committees.id,
        code: committees.code,
        name: committees.name,
        description: committees.description,
      })
      .from(committees)
      .where(eq(committees.active, true))
      .orderBy(asc(committees.name));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});
