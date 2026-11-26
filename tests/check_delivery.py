"""Run the same checks locally and on GitHub Actions."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread

from werkzeug.serving import WSGIRequestHandler, make_server

from serve_browser_fixture import create_browser_fixture

ROOT = Path(__file__).resolve().parents[1]


class FixtureLogs(WSGIRequestHandler):
    def log_request(self, code="-", size="-"):
        if not str(code).startswith(("2", "3")):
            super().log_request(code, size)


def main():
    subprocess.run([sys.executable, "-m", "ruff", "check", "--select", "F821,F822,F823", "."],
                   cwd=ROOT, check=True)
    subprocess.run(["node", "tests/test_math_input.js"], cwd=ROOT, check=True)

    with tempfile.TemporaryDirectory(prefix="study-browser-") as directory:
        app = create_browser_fixture(Path(directory))
        try:
            with make_server("127.0.0.1", 0, app, threaded=True, request_handler=FixtureLogs) as server:
                env = {**os.environ, "STUDY_QA_URL": f"http://127.0.0.1:{server.server_port}"}
                worker = Thread(target=server.serve_forever)
                worker.start()
                try:
                    subprocess.run(["node", "tests/browser_math_sequences.cjs"], cwd=ROOT, env=env, check=True)
                finally:
                    server.shutdown()
                    worker.join()
        finally:
            app.extensions["stop_background"]()

    print("delivery-gate passed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error, file=sys.stderr)
        raise SystemExit(error.returncode)
