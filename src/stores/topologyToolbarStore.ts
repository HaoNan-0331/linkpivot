import { create } from 'zustand'

interface TopologyToolbarState {
  // Phase 19 / REN-02（P14）：字段 optional 化——与 TopologySummary 对齐，兼容持久化历史 JSON
  topologies: { id?: string; name?: string; status?: string }[]
  currentTopologyId: string | null
  onTopologyChange: (id: string | null) => void
  onNew: (name: string) => void
  onSave: () => void
  onDelete: () => void
  onImport: (jsonStr: string) => void
  onExport: () => void
}

interface ToolbarStore {
  toolbar: TopologyToolbarState | null
  setToolbar: (state: TopologyToolbarState | null) => void
}

export const useTopologyToolbarStore = create<ToolbarStore>((set) => ({
  toolbar: null,
  setToolbar: (state) => set({ toolbar: state }),
}))
