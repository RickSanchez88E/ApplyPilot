-- Add 'suspended' state to the job_state enum to match TypeScript types
ALTER TYPE job_state ADD VALUE IF NOT EXISTS 'suspended';
