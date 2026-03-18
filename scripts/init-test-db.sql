SELECT 'CREATE DATABASE spatula_test OWNER spatula'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'spatula_test')\gexec
