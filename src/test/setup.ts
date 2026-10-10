process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.INTERNAL_SERVICE_SECRET ||= 'test-only-internal-secret';
process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:5432/clinic_growth_db?schema=public';
