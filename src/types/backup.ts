/**
 * 备份配置与状态类型（D-05：对齐 ScheduleConfig，扩展 retention）。
 * DB 持久化行（backup_config 表，id=1 singleton），字段映射见 BackupScheduler.getConfig。
 */
export interface BackupConfig {
  id: number
  /** 是否启用定时备份（默认 true，D-01：app ready 即启动 24h 周期备份） */
  enabled: boolean
  /** 定时备份间隔（分钟），默认 1440 = 24h（D-01） */
  intervalMinutes: number
  lastRun: string | null
  nextRun: string | null
  /** 周期桶滚动保留份数，默认 7（D-02） */
  periodicRetention: number
  /** 迁移桶滚动保留份数，默认 5（D-02，独立裁剪不混入周期桶） */
  premigrationRetention: number
}

export interface BackupStatus {
  isRunning: boolean
  isTaskRunning: boolean
  config: BackupConfig
}

export interface UpdateBackupInput {
  enabled?: boolean
  intervalMinutes?: number
  periodicRetention?: number
  premigrationRetention?: number
}

/** BackupConfig 默认值（首次 getConfig 时 lazy-seed 用） */
export const DEFAULT_BACKUP_CONFIG = {
  enabled: true,
  intervalMinutes: 1440,
  periodicRetention: 7,
  premigrationRetention: 5,
} as const
