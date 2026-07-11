#!/usr/bin/env python3
"""
ACOLITE — Serveur relais local (bonus sécurité)
================================================
Cache les clés API côté serveur : le navigateur appelle ce script,
et c'est LUI qui parle à Gemini/Groq avec les vraies clés.

Usage :
  1. Mets tes clés ci-dessous (ou en variables d'environnement)
  2. python3 proxy.py            → écoute sur http://localhost:8787
  3. Dans config.js, tu pourras remplacer les appels directs plus tard.

100 % bibliothèque standard Python — rien à installer.
"""
import json, os, urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

KEYS = {
    "gemini": os.environ.get("GEMINI_KEY", "COLLE_TA_CLE_AIza_ICI"),
    "groq":   os.environ.get("GROQ_KEY",   "COLLE_TA_CLE_gsk_ICI"),
}
PORT = 8787

ROUTES = {
    "/gemini": lambda path: f"https://generativelanguage.googleapis.com{path}?key={KEYS['gemini']}",
    "/groq":   lambda path: "https://api.groq.com/openai/v1/chat/completions",
}

class Proxy(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.path.startswith("/gemini"):
                sub = self.path[len("/gemini"):] or "/v1beta/models/gemini-2.5-flash:generateContent"
                url = ROUTES["/gemini"](sub)
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            elif self.path.startswith("/groq"):
                req = urllib.request.Request(ROUTES["/groq"](None), data=body, headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {KEYS['groq']}",
                })
            else:
                self.send_response(404); self._cors(); self.end_headers(); return
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                self.send_response(r.status); self._cors()
                self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code); self._cors(); self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(500); self._cors(); self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, *a): pass

if __name__ == "__main__":
    print(f"🔐 Relais Acolite prêt sur http://localhost:{PORT}  (Ctrl+C pour arrêter)")
    HTTPServer(("127.0.0.1", PORT), Proxy).serve_forever()
