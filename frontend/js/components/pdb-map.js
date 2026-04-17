/**
 * @fileoverview <pdb-map> Custom Web Component.
 * Encapsulates Leaflet.js mapping logic and OpenStreetMap tile rendering.
 * Supports clustering multiple locations keyed by entity type for color-coding.
 * Features an internal asynchronous geocoding queue using Nominatim API to lazily resolve
 * geographical coordinates for entities lacking explicit lat/lon data, seamlessly updating
 * the view boundary as locations resolve.
 */

const TEMPLATE = /** @type {HTMLTemplateElement} */ (document.getElementById('tpl-pdb-map'));

// Geocoding queue to respect Nominatim's strict 1 RPS policy
const NominatimCache = new Map();
/** @type {Array<{address: string, callback: (coords: {lat: number, lon: number}|null) => void}>} */
let geocodeQueue = [];
let isGeocoding = false;

async function processGeocodeQueue() {
    if (isGeocoding || geocodeQueue.length === 0) return;
    isGeocoding = true;
    while (geocodeQueue.length > 0) {
        const { address, callback } = geocodeQueue.shift();
        
        if (NominatimCache.has(address)) {
            callback(NominatimCache.get(address));
            continue;
        }

        try {
            const res = await globalThis.fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`, {
                headers: { 'User-Agent': 'PDBFE-Mirror/1.0' }
            });
            const data = await res.json();
            if (data && data.length > 0) {
                const coords = { lat: Number.parseFloat(data[0].lat), lon: Number.parseFloat(data[0].lon) };
                NominatimCache.set(address, coords);
                callback(coords);
            } else {
                NominatimCache.set(address, null);
                callback(null);
            }
        } catch {
            NominatimCache.set(address, null);
            callback(null);
        }
        
        await new Promise(r => setTimeout(r, 1050));
    }
    isGeocoding = false;
}

export class PdbMap extends HTMLElement {
    constructor() {
        super();
        this._locations = {};
        /** @type {any} Leaflet map instance */
        this._map = null;
        /** @type {HTMLElement|null} */
        this._mapContainer = null;
    }

    connectedCallback() {
        if (!this.firstElementChild) {
            this.appendChild(TEMPLATE.content.cloneNode(true));
        }

        // Initialize leaflet map slightly deferred to ensure DOM layout is complete
        // and dimensions are available for Leaflet's tile engine.
        globalThis.requestAnimationFrame(() => {
            this._initMap();
        });
    }

    disconnectedCallback() {
        if (this._map) {
            this._map.remove();
            this._map = null;
        }
    }

    /**
     * Sets the locations to plot on the map.
     * @param {Record<string, Array<{lat: number, lon: number, name: string}>>} locGroups
     */
    setLocations(locGroups) {
        this._locations = locGroups;
        if (this._map) {
            this._renderMarkers();
        }
    }

    _initMap() {
        const instanceDiv = this.querySelector('.pdb-map-instance');
        if (!instanceDiv) return;
        this._mapContainer = /** @type {HTMLElement} */ (instanceDiv);

        // If globalThis.L (Leaflet) isn't loaded for some reason, abort cleanly.
        if (!/** @type {any} */ (globalThis).L) {
            console.error('Leaflet is not available in the global scope.');
            return;
        }

        const isModal = this.hasAttribute('is-modal');

        // Standard Leaflet Initialization
        this._map = /** @type {any} */ (globalThis).L.map(this._mapContainer, {
            zoomControl: isModal,
            dragging: isModal,
            touchZoom: isModal,
            scrollWheelZoom: false, // Prevent page scrolling hijacking entirely
            doubleClickZoom: isModal,
            boxZoom: isModal,
            keyboard: isModal,
            tap: isModal
        });

        if (!document.getElementById('pdb-map-styles')) {
            const style = document.createElement('style');
            style.id = 'pdb-map-styles';
            style.textContent = `
                .pdb-map-label {
                    background: var(--bg-primary) !important;
                    border: 1px solid var(--border) !important;
                    color: var(--text-primary) !important;
                    border-radius: var(--radius-sm) !important;
                    padding: 2px 6px !important;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2) !important;
                    font-size: 0.75rem;
                    font-weight: 500;
                    white-space: nowrap;
                    opacity: 1 !important;
                }
                .pdb-map-label::before { display: none; }
                .pdb-map-instance.hide-labels .leaflet-tooltip { display: none !important; }
                .pdb-map-interactive { cursor: pointer !important; }
                .pdb-map-interactive .leaflet-interactive { cursor: pointer !important; }
            `;
            document.head.appendChild(style);
        }

        if (!isModal) {
            this._mapContainer.classList.add('pdb-map-interactive');
            this._map.on('click', () => this._openModal());
        }

        this._map.on('zoomend', () => {
            if (this._map.getZoom() < 12) {
                this._mapContainer.classList.add('hide-labels');
            } else {
                this._mapContainer.classList.remove('hide-labels');
            }
        });

        // Initialize label visibility state
        if (this._map.getZoom() < 12) {
            this._mapContainer.classList.add('hide-labels');
        }

        // OpenStreetMap raster tiles (Confirmed acceptable within privacy budget)
        /** @type {any} */ (globalThis).L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(this._map);

        this._renderMarkers();
    }

    _openModal() {
        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            background: 'rgba(0,0,0,0.8)', zIndex: '9999',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-xl)'
        });

        const modalBox = document.createElement('div');
        Object.assign(modalBox.style, {
            width: '100%', maxWidth: '1200px', height: '100%', maxHeight: '800px',
            background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
            position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column'
        });

        const cleanup = () => {
            overlay.remove();
            document.removeEventListener('keydown', handleEsc);
        };
        
        const handleEsc = (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Escape') cleanup();
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕ Close';
        Object.assign(closeBtn.style, {
            position: 'absolute', top: '10px', right: '10px', zIndex: '1000',
            background: 'var(--bg-primary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', padding: '6px 12px',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            fontSize: '0.9rem', fontWeight: 'bold', boxShadow: '0 1px 4px rgba(0,0,0,0.3)'
        });
        closeBtn.addEventListener('click', cleanup);
        document.addEventListener('keydown', handleEsc);
        
        modalBox.appendChild(closeBtn);

        const largeMap = document.createElement('pdb-map');
        largeMap.setAttribute('is-modal', 'true');
        largeMap.style.flex = '1';
        modalBox.appendChild(largeMap);

        overlay.appendChild(modalBox);
        document.body.appendChild(overlay);

        // Inject same points
        globalThis.requestAnimationFrame(() => {
            if (typeof /** @type {any} */ (largeMap).setLocations === 'function') {
                /** @type {any} */ (largeMap).setLocations(this._locations);
            }
        });
    }

    _renderMarkers() {
        if (!this._map) return;

        // Strip existing markers if this is a re-render
        this._map.eachLayer((/** @type {any} */ layer) => {
            if (layer instanceof /** @type {any} */ (globalThis).L.Marker) {
                this._map.removeLayer(layer);
            }
        });

        this._bounds = /** @type {any} */ (globalThis).L.latLngBounds();

        for (const [tag, points] of Object.entries(this._locations)) {
            if (!points?.length) continue;

            const colorVar = `var(--type-${tag}, var(--accent))`;
            const iconHtml = `<div style="background-color: ${colorVar}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--bg-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>`;
            const customIcon = /** @type {any} */ (globalThis).L.divIcon({
                html: iconHtml,
                className: 'pdb-map-marker',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
                popupAnchor: [0, -9]
            });

            for (const pt of points) {
                if (typeof pt.lat === 'number' && typeof pt.lon === 'number') {
                    this._plotSingleMarker(pt.lat, pt.lon, pt.name, customIcon);
                } else if (pt.address) {
                    this._geocodePlotMarker(pt.address, pt.name, customIcon);
                }
            }
        }
        
        if (!this._bounds.isValid()) {
            this._map.setView([20, 0], 2);
        }
    }

    /**
     * @param {number} lat
     * @param {number} lon
     * @param {string} name
     * @param {any} customIcon
     */
    _plotSingleMarker(lat, lon, name, customIcon) {
        if (!this._map) return;
        const pointLatLng = [lat, lon];
        
        const marker = /** @type {any} */ (globalThis).L.marker(pointLatLng, { icon: customIcon })
            .bindPopup(`<b>${escapeHTML(name)}</b>`);

        if (this.hasAttribute('is-modal')) {
            marker.bindTooltip(escapeHTML(name), {
                permanent: true,
                direction: 'right',
                className: 'pdb-map-label',
                offset: [10, 0]
            });
        }

        marker.addTo(this._map);

        this._bounds.extend(pointLatLng);
        this._map.fitBounds(this._bounds, { padding: [20, 20], maxZoom: 15 });
        // Force Leaflet to recalculate size in case DOM layout was slightly delayed
        setTimeout(() => { if(this._map) { this._map.invalidateSize(); this._map.fitBounds(this._bounds, { padding: [20, 20], maxZoom: 15 }); } }, 100);
    }

    /**
     * @param {string} address
     * @param {string} name
     * @param {any} customIcon
     */
    _geocodePlotMarker(address, name, customIcon) {
        const cached = NominatimCache.get(address);
        if (cached) {
            if (cached.lat !== undefined) {
                this._plotSingleMarker(cached.lat, cached.lon, name, customIcon);
            }
            return;
        }
        
        geocodeQueue.push({
            address,
            callback: (/** @type {any} */ coords) => {
                if (coords) this._plotSingleMarker(coords.lat, coords.lon, name, customIcon);
            }
        });
        processGeocodeQueue();
    }
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

customElements.define('pdb-map', PdbMap);
