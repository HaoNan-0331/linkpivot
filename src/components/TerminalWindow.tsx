import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'

export default function TerminalWindow() {
  const termRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!termRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      // xterm option 不吃 CSS 变量——传 D-04 代码栈字面值（与 src/styles/fonts.css 的
      // --nt-font-family-code 同上游同串；无裸 monospace 尾巴，中文回落雅黑非宋体）
      fontSize: 14,
      fontFamily:
        "'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei'",
      theme: {
        // 终端语义色：字面值锚定 --nt-specific-terminal-bg（tokens.css）；
        // 本文件在 audit:tokens 豁免清单内（UI-SPEC §十 Q6 / §九）
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(termRef.current)
    fitAddon.fit()

    terminalRef.current = terminal

    // Handle user input -> send to main process
    terminal.onData((data) => {
      window.terminalApi.write(data)
    })

    // Handle data from main process -> write to terminal
    window.terminalApi.onData((data: string) => {
      terminal.write(data)
    })

    // Handle window resize
    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      terminal.dispose()
    }
  }, [])

  return <div ref={termRef} style={{ width: '100%', height: '100%' }} />
}
