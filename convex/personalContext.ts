import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { bounded, requireMember } from "./lib/auth";
export const add = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    title: v.string(),
    body: v.string(),
    useForAgent: v.boolean(),
  },
  handler: async (ctx, args): Promise<Id<"wikiPages">> => {
    await requireMember(ctx, args.workspaceId);
    const title = bounded(args.title, 160, "Title"),
      body = bounded(args.body, 2000, "Context");
    const entityIds: Id<"entities">[] = [];
    if (args.useForAgent) {
      const sourceId = await ctx.runMutation(api.knowledge.createSource, {
        workspaceId: args.workspaceId,
        title,
        text: body,
      });
      const entityId: Id<"entities"> = await ctx.runMutation(
        api.knowledge.createEntity,
        {
          workspaceId: args.workspaceId,
          kind: "note",
          title,
          summary: body,
          aliases: [],
          sourceRefs: [{ sourceId, revision: 1 }],
          evidence: body,
        },
      );
      await ctx.runMutation(api.knowledge.decideEntity, {
        entityId,
        expectedRevision: 1,
        decision: "approve",
      });
      entityIds.push(entityId);
    }
    return ctx.runMutation(api.knowledge.createPage, {
      workspaceId: args.workspaceId,
      title,
      body,
      entityIds,
    });
  },
});
