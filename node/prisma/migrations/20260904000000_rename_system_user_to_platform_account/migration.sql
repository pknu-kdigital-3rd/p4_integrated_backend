-- Rename the existing account table without losing data.
ALTER TABLE "system_user" RENAME TO "platform_account";

ALTER TABLE "platform_account"
    RENAME CONSTRAINT "system_user_pkey" TO "platform_account_pkey";

ALTER INDEX "system_user_login_id_key"
    RENAME TO "platform_account_login_id_key";

ALTER TABLE "platform_account"
    RENAME CONSTRAINT chk_system_user_role TO chk_platform_account_role;
