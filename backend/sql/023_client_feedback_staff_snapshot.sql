ALTER TABLE `client_feedback_conversation`
  ADD COLUMN IF NOT EXISTS `client_account_type` VARCHAR(16) NOT NULL DEFAULT 'personal' COMMENT '客户端账号类型快照(personal/department)' AFTER `department_name_snapshot`,
  ADD COLUMN IF NOT EXISTS `staff_no_snapshot` VARCHAR(64) NULL COMMENT '客户端教职工号快照' AFTER `client_account_type`;
