import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// RPC control messages never enter the model transcript. Custom entries persist
// navigation positions without introducing messages into the model context.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("pocketdesk-history", {
    description: "PocketDesk 会话历史控制",
    handler: async (args, ctx) => {
      let request: any;
      try {
        request = JSON.parse(args);
        const sm = ctx.sessionManager;
        if (typeof ctx.navigateTree !== "function" || typeof sm?.getEntries !== "function" || typeof ctx.isIdle !== "function" || typeof ctx.hasPendingMessages !== "function") throw new Error("当前 Pi 不支持历史导航，请更新 Pi");
        if (typeof sm.getSessionFile !== "function" || !sm.getSessionFile()) throw new Error("当前 Pi 不支持历史导航（未启用会话文件），请移除 --no-session");
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("请先结束当前轮及待发送消息");
        if (request.action === "navigate") {
          const target = sm.getEntry(request.targetId);
          if (!target) throw new Error("历史节点不存在");
          if (request.mode === "edit" && !(target.type === "message" && target.message.role === "user")) throw new Error("只能编辑用户消息");
          if (request.mode !== "edit" && target.type === "message" && target.message.role === "user") throw new Error("请选择该分支的保存位置，或修改这条消息");
          if (request.expectedLeaf !== sm.getLeafId()) throw new Error("历史已变化，请刷新后重试");
          // Persist the old position, including an unfinished user-message leaf.
          pi.appendEntry("pocketdesk.position", { previous: sm.getLeafId() });
          const result = await ctx.navigateTree(request.targetId, { summarize: false });
          if (result.cancelled) {
            ctx.ui.notify("pocketdesk:history " + JSON.stringify({ id: request.id, success: true, data: { cancelled: true } }), "info");
            return;
          }
          pi.appendEntry("pocketdesk.position", { operationId: request.operationId });
        } else if (request.action === "bindings") {
          pi.appendEntry("pocketdesk.bindings", request.input);
        } else if (request.action === "checkpoint") {
          pi.appendEntry("pocketdesk.checkpoint", request.input);
        } else if (request.action === "input") {
          pi.appendEntry("pocketdesk.input", request.input);
        } else if (request.action !== "read") {
          throw new Error("未知历史操作");
        }
        const entries = sm.getEntries();
        ctx.ui.notify("pocketdesk:history " + JSON.stringify({ id: request.id, success: true, data: {
          entries: request.action === "input" || request.action === "checkpoint" || request.action === "bindings" ? [] : entries, leafId: sm.getLeafId(), sessionFile: sm.getSessionFile(), cancelled: false,
        } }), "info");
      } catch (error) {
        ctx.ui.notify("pocketdesk:history " + JSON.stringify({ id: request?.id, success: false, error: String(error) }), "error");
      }
    },
  });
}
