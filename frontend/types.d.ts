/**
 * Frontend type definitions for TypeScript validation (tsc --noEmit).
 * These types are used in JSDoc annotations across the frontend JS files.
 */

/**
 * User session data returned by the auth worker's /session endpoint.
 */
interface SessionData {
    id: number;
    username: string;
    name: string;
    given_name?: string;
    email: string;
    networks: Array<{ id: number; asn: number; name: string }>;
    keys?: Array<{ name: string; created: string }>;
}

/**
 * PeeringDB entity record. Used as a generic type for API responses
 * where the exact shape depends on the entity type.
 */
interface PDBRecord {
    id: number;
    name?: string;
    asn?: number;
    city?: string;
    country?: string;
    [key: string]: any;
}

/**
 * Extend Window to include the SPA router exposed by boot.js.
 */
interface Window {
    __router: { navigate: (path: string) => void };
}
