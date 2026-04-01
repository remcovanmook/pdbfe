#!/usr/bin/env python3
"""
Local development server for the PeeringDB SPA.
Serves static files from the frontend directory, with SPA fallback
routing: any path that doesn't match a real file gets index.html.
Disables caching to avoid stale files during development.
"""

import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8088
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class SPAHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with SPA fallback and no-cache headers."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        # Strip query string for file lookup
        path = self.path.split('?')[0]

        # If it's a real file (has extension), serve it directly
        file_path = os.path.join(DIRECTORY, path.lstrip('/'))
        if os.path.isfile(file_path):
            return super().do_GET()

        # SPA fallback: serve index.html for all non-file routes
        self.path = '/index.html'
        return super().do_GET()

    def end_headers(self):
        # Disable caching for development
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    with http.server.HTTPServer(('', PORT), SPAHandler) as httpd:
        print(f'Serving {DIRECTORY} at http://localhost:{PORT}')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')
