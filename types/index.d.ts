export type Disk = { used: number; total: number; kind: 'SSD' | 'HDD' | null }
export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Task = { id: string; subject: string; activeForm: string | null; status: TaskStatus }
export type AgentRow = {
  id: string
  name: string
  model: string | null
  description: string
  type: string
  status: string
  seenAt: number
}
export type Res = { cpu: number | null; ramUsed: number | null; ramTotal: number | null; disk: Disk | null }
export type Ctx = { percent: number; window: number }
export type Limit = { percent: number; resetsAt: string | null }
export type Info = {
  email: string | null
  model: string | null
  fiveHour: Limit | null
  weekly: Limit | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-hud': { info: Shaped<Info | null>; effort: string | null; context: Shaped<Ctx | null>; res: Shaped<Res | null>; tasks: Shaped<Task[]>; showAllTasks: boolean; frame: number; agents: Shaped<AgentRow[]> }
  }
}
