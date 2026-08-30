// Phase 33 / UI-02+UI-03（33-UI-SPEC §六映射契约表 + §3.4 AntD 字体映射）。
// 本文件与 src/styles/tokens.css 是「同 dsh 上游的两份拷贝」，靠注释交叉引用锚定一致性：
//   - 主操作色 = antd 原蓝 rgb(22, 119, 255) / #1677ff（D-03 决策变更：2026-08-29 用户真机
//     目检后拍板，由近黑 rgb(15, 17, 21) 回退 antd 原蓝；hover/active 派生由 fast-color 蓝族自动生成）
//   - 正文/主文字色 base 仍为近黑 rgb(15, 17, 21)（colorTextBase）
//   - 信息蓝 = 品牌蓝 500 档 rgb(65, 118, 230)；成功/警示/危险 = green-500 / amber-500 / red-600
//   - 阴影三 token 全指 lv3 字面值（与 tokens.css 阴影段一字不差，见 SHADOW_LV3）
//   - 字体双栈与 fonts.css 同上游逐字同串（正文栈含雅黑，代码栈无裸 monospace 尾巴）
//
// 双轨铁律（红线，code review 视违反为红灯）：
//   1. seed 色板 token 永远传字面值，禁 var() —— fast-color 派生链无法解析 var() 会产出垃圾色；
//   2. 不配 cssVar / hashed —— AntD 6 cssVar 已无条件常开（key 默认 css-var-root）；
//   3. --nt-* 不进 antd theme；自研样式禁引 --ant-*（两轨单向映射防色板撕裂）。
import type { ThemeConfig } from 'antd'

// 浮层统一阴影（UI-SPEC §5.4：Menu/Modal/Dropdown/Tooltip 全走 lv3）
const SHADOW_LV3 =
  '0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08)'

export const ntTheme: ThemeConfig = {
  token: {
    // —— 色板 seed（必须字面值）——
    // 主操作色 = antd 原蓝 #1677ff（D-03 决策变更，tokens.css brand 组主操作填充槽位同值）
    colorPrimary: 'rgb(22, 119, 255)',
    colorInfo: 'rgb(65, 118, 230)',
    colorSuccess: 'rgb(34, 197, 94)',
    colorWarning: 'rgb(245, 158, 11)',
    colorError: 'rgb(236, 19, 19)',
    colorTextBase: 'rgb(15, 17, 21)',
    colorBgBase: 'rgb(255, 255, 255)',
    colorBgLayout: 'rgb(249, 250, 251)',
    // 全局 hover 透明度档（ghost hover 透明度档全局落点，tokens.css interactive 组同值；
    // 注：antd 6.5.4 无 colorBgContainerHover token，全局条目 hover 载体是 controlItemBgHover）
    controlItemBgHover: 'rgba(38, 49, 72, 0.06)',
    // —— 字体（D-04 双栈；antd 默认栈无 CJK、代码栈带裸 monospace 尾巴——必改项）——
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontFamilyCode:
      "'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei'",
    fontSize: 14,
    fontSizeSM: 12,
    fontSizeLG: 16,
    // 14/22 为 antd 默认派生同值，显式写出锚定语义（s-14 档）
    lineHeight: 22 / 14,
    // 显式覆盖：默认约 1.667 得 20px，dsh 要求 12/18（1.5×12=18）
    lineHeightSM: 1.5,
    // 显式覆盖：默认 1.5 得 24px，dsh 要求 16/28（1.75×16=28）
    lineHeightLG: 1.75,
    // dsh 的 strong 档是 500 不是 600
    fontWeightStrong: 500,
    // —— 胶囊高度体系（SC3）——
    controlHeight: 36,
    // 显式配对：默认按 0.75 派生得 27 ≠ 28（Pitfall 4）
    controlHeightSM: 28,
    controlHeightLG: 40,
    // —— 圆角分级（D-06：控件 8 / 浮层 12）——
    borderRadius: 8,
    borderRadiusSM: 6,
    borderRadiusLG: 12,
    // —— 阴影三 token 全指 lv3（浮层统一观感）——
    boxShadow: SHADOW_LV3,
    boxShadowSecondary: SHADOW_LV3,
    boxShadowTertiary: SHADOW_LV3,
  },
  components: {
    Button: {
      // 胶囊专项：radius = height / 2（36→18、28→14、lg 40→20）
      borderRadius: 18,
      borderRadiusSM: 14,
      borderRadiusLG: 20,
      // ghost（default/text 型）hover/active 透明度档（tokens.css interactive 组同值；
      // 注：antd 6.5.4 Button 无 textActiveBg token——text 型 active 底色不可配，由
      // defaultActiveBg 承载 active 档语义）
      defaultHoverBg: 'rgba(38, 49, 72, 0.06)',
      defaultActiveBg: 'rgba(38, 49, 72, 0.1)',
      textHoverBg: 'rgba(38, 49, 72, 0.06)',
    },
  },
}
