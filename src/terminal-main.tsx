import React from 'react'
import { createRoot } from 'react-dom/client'
import TerminalWindow from './components/TerminalWindow'
import 'xterm/css/xterm.css'
// Phase 33 / UI-02+UI-03（UI-SPEC §十 Q6 裁决：终端入口纳入字体栈/滚动条，AntD theme 天然不涉 xterm）
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/scrollbar.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TerminalWindow />
  </React.StrictMode>
)
