-- =============================================
-- 文件说明：backend/sql/017_task4_system_config_text_and_constraints.sql
-- 文件职责：为 Task4 补齐系统配置长文本承载能力，避免验证码模板等长文本被 VARCHAR(255) 截断。
-- 维护说明：若后续再次扩展系统配置长文本治理，请同步更新实体 `system-config.entity.ts` 与本脚本。
-- =============================================

ALTER TABLE `system_configs`
  MODIFY COLUMN `config_value` TEXT NOT NULL COMMENT '配置值';
