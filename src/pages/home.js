// home.js —— 首页 = 统一参考视图。
//
// 本轮（P3.1 之后的 UI 简化）把首页改造成「画册式参考界面」：搜索框就在图片墙
// 上面，输入后**原位出结果**，不再跳到另一套 FIND 页面。
//
// 实现上这里刻意只做一件事：把同一份视图以 asHome 模式挂载。
// 为什么不是复制一份检索代码：本轮明令不修改已验证的检索与 Vision 内核，
// 复制就会产生第二份 runSearch，之后改打分或门禁要改两处，迟早不一致。
// asHome 只换外层标记（栏目眉 + 图片墙 + 紧凑搜索），检索管线、实例守卫、
// 远程渠道、纠正与 Vision 三道闸门全部是同一份代码。
import { renderFind } from "./find.js";

export function renderHome(app) {
  renderFind(app, { asHome: true });
}