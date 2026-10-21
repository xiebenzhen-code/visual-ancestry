// 自动生成，请勿手改。源：.rc1-audit/p415/v2-analyses/*.json 与 preflight-state.json（真实付费输出）。
export const VISION_PROFILES = {
  "note": "只收录已付费的独立单图分析（A 级）。未列入的作品没有独立画像，界面必须标「未分析」，不得用档案描述冒充模型结论。",
  "profiles": {
    "paris-rainy-day": {
      "tier": "A",
      "source": "single-image-analysis",
      "callId": "paris-rainy-day",
      "model": "deepseek-flash",
      "promptVersion": "p415-v2.3",
      "at": "2026-10-20T17:33:06.492Z",
      "composition": "斜向街道透视，建筑与路面线条向画面左后方汇聚",
      "subject": "雨天城市街道上的行人，前景为一对撑伞男女，中远景散布多名撑伞行人",
      "subjectCount": 10,
      "space": "湿滑的石板路面与右侧人行道，前景撑伞男女及右侧背对人物 / 路灯、左侧推车与行走行人，街道向远处延伸 / 两侧多层建筑立面与远处街角建筑，天空灰白",
      "color": "灰蓝、灰褐与米黄的冷灰调，右侧墙面带暖红",
      "light": "来自上方偏左的漫射天光 / 软、漫射",
      "unknown": [
        "人物具体身份",
        "建筑具体地点",
        "伞下人物面部细节"
      ]
    },
    "fan-kuan-travelers": {
      "tier": "A",
      "source": "single-image-analysis",
      "callId": "fan-kuan-travelers",
      "model": "deepseek-flash",
      "promptVersion": "p415-v2.3",
      "at": "2026-10-20T17:33:11.588Z",
      "composition": "竖向中轴式，主峰居中偏上，前景横向岩层压底",
      "subject": "竖幅山水，中央一座巨大陡峭山体占据大部分画面，前景为岩石与松林，右侧山壁间有一道细长瀑布；画面中未见可辨识的人物",
      "subjectCount": 0,
      "space": "底部岩石、坡地与松树群，笔触较密 / 中下部隆起的岩丘与树丛，其上为大片雾气/留白过渡 / 高耸的主峰与两侧山壁，顶部有浓密树冠",
      "color": "深墨绿褐的山体与暖褐黄底色的对比",
      "light": "柔和漫射，无明确点光源",
      "unknown": [
        "light.direction",
        "figures（画面中无可辨识人物）"
      ]
    },
    "guo-xi-early-spring": {
      "tier": "A",
      "source": "single-image-analysis",
      "callId": "guo-xi-early-spring",
      "model": "deepseek-flash",
      "promptVersion": "p415-v2.3",
      "at": "2026-10-20T17:33:16.423Z",
      "composition": "纵向高远式层叠结构，主峰居中偏上，山体呈S形或之字形向上堆叠",
      "subject": "绢本水墨山水，画面主体为层叠山峦、松树与枯枝树丛，山间有瀑布、溪流与若干建筑；画面中可见的人物极小，位于下方水岸处，数量约2个，难以确认",
      "subjectCount": 2,
      "space": "下方岩石、松树与枯枝树丛，水岸与溪流 / 中段山体、瀑布、建筑与树丛 / 上方高耸主峰与淡墨远山，顶部留出绢地",
      "color": "绢地暖黄褐色与墨色浓淡的单色关系",
      "light": "软、漫射",
      "unknown": [
        "light.direction",
        "figures[0].facing",
        "figures[0].relation 的具体互动关系"
      ]
    },
    "american-gothic": {
      "tier": "A",
      "source": "single-image-analysis",
      "callId": "preflight-A2",
      "model": "deepseek-flash",
      "promptVersion": "p415-v2.2",
      "at": null,
      "composition": "近对称的竖向并列结构，中央由房屋尖顶与干草叉形成垂直轴线",
      "subject": "一男一女两人并排站立，男子手持三齿干草叉；背景为一栋带尖顶阁楼窗的木结构房屋",
      "subjectCount": 2,
      "space": "",
      "color": null,
      "light": "来自画面左前方偏上 / 较硬、方向明确的直射光",
      "unknown": [
        "人物身份",
        "具体地点",
        "创作意图"
      ]
    }
  }
};
