-- One-time migration: fix logo URLs from PeeringDB JSON dump.
--
-- The JSON dumps use Django's test server hostname (http://testserver/m/)
-- for media URLs. This rewrites them to the production S3 bucket.
--
-- Run via:
--   npx wrangler d1 execute peeringdb --file scripts/fix_logo_urls.sql --remote

UPDATE peeringdb_organization
SET logo = REPLACE(logo, 'http://testserver/m/', 'https://peeringdb-media-prod.s3.amazonaws.com/media/')
WHERE logo LIKE 'http://testserver/m/%';

UPDATE peeringdb_network
SET logo = REPLACE(logo, 'http://testserver/m/', 'https://peeringdb-media-prod.s3.amazonaws.com/media/')
WHERE logo LIKE 'http://testserver/m/%';

UPDATE peeringdb_ix
SET logo = REPLACE(logo, 'http://testserver/m/', 'https://peeringdb-media-prod.s3.amazonaws.com/media/')
WHERE logo LIKE 'http://testserver/m/%';

UPDATE peeringdb_facility
SET logo = REPLACE(logo, 'http://testserver/m/', 'https://peeringdb-media-prod.s3.amazonaws.com/media/')
WHERE logo LIKE 'http://testserver/m/%';

UPDATE peeringdb_carrier
SET logo = REPLACE(logo, 'http://testserver/m/', 'https://peeringdb-media-prod.s3.amazonaws.com/media/')
WHERE logo LIKE 'http://testserver/m/%';

UPDATE peeringdb_campus
SET logo = REPLACE(logo, 'http://testserver/m/', 'https://peeringdb-media-prod.s3.amazonaws.com/media/')
WHERE logo LIKE 'http://testserver/m/%';
