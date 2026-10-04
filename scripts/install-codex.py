#!/usr/bin/env python3
"""Install the reviewed Jev plugin and separate ARM64 Codex runtime."""
import argparse
import hashlib
import json
import os
import plistlib
from pathlib import Path
import selectors
import shutil
import subprocess
import time


EVENTS = {"sessionStart", "preCompact", "postCompact"}


def check_runtime(root):
    metadata = json.loads((root / "codex-package.json").read_text())
    if metadata.get("target") != "aarch64-apple-darwin" or metadata.get("entrypoint") != "bin/codex" or metadata.get("layoutVersion") != 1 or metadata.get("version") != "0.159.0-jev.0":
        raise ValueError("Runtime must use the ARM64 macOS package layout")
    binary = root / "bin/codex"
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    entries = [line.split() for line in (root / "SHA256SUMS").read_text().splitlines() if line.strip()]
    matches = [entry for entry in entries if len(entry) == 2 and entry[1].lstrip("*") in ("bin/codex", "codex-runtime/bin/codex")]
    if len(matches) != 1 or matches[0][0] != digest:
        raise ValueError("Codex runtime SHA256 checksum mismatch")
    return binary


def copy_credentials(source, destination):
    credentials = json.loads(source.read_text())
    if credentials.get("provider") != "openrouter" or not isinstance(credentials.get("apiKey"), str) or not credentials["apiKey"].strip():
        raise ValueError("Existing Jevgrep credentials must use OpenRouter")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({"provider": "openrouter", "apiKey": credentials["apiKey"]}, output)


def link(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        destination.unlink()
    elif destination.exists():
        raise ValueError(f"Refusing to replace non-symlink: {destination}")
    destination.symlink_to(source)


class AppServer:
    def __init__(self, binary, env):
        self.process = subprocess.Popen([str(binary), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, bufsize=0)
        self.sequence = 0
        self.buffer = b""
        self.request("initialize", {"clientInfo": {"name": "fast-jev-installer", "version": "0.5.2"}, "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        self.send({"id": self.sequence, "method": method, "params": params})
        deadline = time.monotonic() + 30
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if b"\n" not in self.buffer:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        break
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("Codex app-server stopped")
                    self.buffer += chunk
                    continue
                line, self.buffer = self.buffer.split(b"\n", 1)
                result = json.loads(line)
                if result.get("id") != self.sequence:
                    continue
                if "error" in result:
                    raise RuntimeError(f"Codex app-server rejected {method}")
                return result["result"]
        raise TimeoutError(f"Codex app-server timeout: {method}")

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


def trust_hooks(server):
    for feature in ("hooks", "plugins"):
        server.request("config/value/write", {"keyPath": "features." + feature, "value": True, "mergeStrategy": "replace"})
    listed = server.request("hooks/list", {})
    entries = listed.get("data", [])
    if any(entry.get("errors") for entry in entries):
        raise ValueError("Hook discovery reported errors")
    hooks = [hook for entry in entries for hook in entry.get("hooks", []) if hook.get("pluginId") == "fast-jev-compaction@fast-jev-compaction"]
    if len(hooks) != 3 or {hook.get("eventName") for hook in hooks} != EVENTS:
        raise ValueError("Expected exactly the three reviewed fast-jev-compaction hooks")
    for hook in hooks:
        expected = '"' + str(Path(hook.get("sourcePath", "")).parent.parent / "bin/codex-hook") + '"'
        if hook.get("handlerType") != "command" or hook.get("command") != expected or not hook.get("currentHash"):
            raise ValueError("Unexpected fast-jev-compaction hook definition")
    for hook in hooks:
        prefix = "hooks.state." + json.dumps(hook["key"])
        for field, value in (("trusted_hash", hook["currentHash"]), ("enabled", True)):
            server.request("config/value/write", {"keyPath": prefix + "." + field, "value": value, "mergeStrategy": "replace"})


def early_compaction(server):
    current = server.request("config/read", {})["config"].get("model_auto_compact_token_limit")
    if current is None or current > 150000:
        server.request("config/value/write", {"keyPath": "model_auto_compact_token_limit", "value": 150000, "mergeStrategy": "replace"})


def desktop_environment(home, launcher):
    label = "ai.fast-jev.codex-runtime"
    path = home / "Library/LaunchAgents" / (label + ".plist")
    payload = {"Label": label, "ProgramArguments": ["/bin/launchctl", "setenv", "CODEX_CLI_PATH", str(launcher)], "RunAtLoad": True}
    if path.exists() and plistlib.loads(path.read_bytes()) != payload:
        raise ValueError("Existing Jev desktop launch configuration differs; preserve it before reinstalling")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(payload))
    subprocess.run(payload["ProgramArguments"], check=True)
    domain = "gui/" + str(os.getuid())
    loaded = subprocess.run(["/bin/launchctl", "print", domain + "/" + label], capture_output=True)
    if loaded.returncode:
        subprocess.run(["/bin/launchctl", "bootstrap", domain, str(path)], check=True)


def install(args):
    source = Path(__file__).resolve().parents[1]
    runtime = args.runtime_dir.resolve()
    check_runtime(runtime)
    node = args.node.resolve()
    version = subprocess.check_output([str(node), "--version"], text=True).strip()
    if not version.startswith("v22."):
        raise ValueError("Use a fixed Node.js 22 executable")
    helpers = args.desktop_resources / "codex-path"
    if not helpers.is_dir():
        raise ValueError("Signed desktop resources must contain codex-path")
    root = args.home / ".codex/fast-jev-compaction"
    credential_source = root / "credentials.json"
    if not credential_source.is_file():
        credential_source = args.home / ".config/jevgrep/credentials.json"
    # Check credentials before changing the installation. Never print keys.
    if credential_source.is_file():
        credentials = json.loads(credential_source.read_text())
    else:
        credentials = {"provider": "openrouter", "apiKey": os.environ.get("OPENROUTER_API_KEY", "")}
    if credentials.get("provider") != "openrouter" or not isinstance(credentials.get("apiKey"), str) or not credentials["apiKey"].strip():
        raise ValueError("Configure an OpenRouter key or existing Jevgrep credentials first")
    plugin = root / "plugin"
    for name in ("dist", "bin", "hooks", ".codex-plugin", ".agents", "runtime"):
        if not (source / name).is_dir():
            raise ValueError(f"Build or supply plugin directory first: {name}")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    plugin.mkdir(parents=True, exist_ok=True)
    for name in ("dist", "bin", "hooks", ".codex-plugin", ".agents", "runtime"):
        shutil.copytree(source / name, plugin / name, dirs_exist_ok=True)
    bundled = root / "runtime/codex-runtime"
    shutil.copytree(runtime, bundled, dirs_exist_ok=True)
    (bundled / "bin/codex").chmod(0o755)
    link(node, root / "runtime/node")
    link(helpers.resolve(), bundled / "codex-path")
    code_host = args.desktop_resources / "bin/codex-code-mode-host"
    if code_host.is_file():
        link(code_host.resolve(), bundled / "bin/codex-code-mode-host")
    resources = args.desktop_resources / "codex-resources"
    if resources.is_dir():
        link(resources.resolve(), bundled / "codex-resources")
    if credential_source.is_file():
        copy_credentials(credential_source, root / "credentials.json")
    else:
        destination = root / "credentials.json"
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(credentials, output)
    binary = bundled / "bin/codex"
    env = dict(os.environ, CODEX_HOME=str(args.home / ".codex"))
    subprocess.run([str(binary), "plugin", "marketplace", "add", str(plugin)], check=True, env=env)
    subprocess.run([str(binary), "plugin", "add", "fast-jev-compaction@fast-jev-compaction", "--json"], check=True, env=env)
    server = AppServer(binary, env)
    try:
        trust_hooks(server)
        early_compaction(server)
    finally:
        server.close()
    launcher = args.home / ".codex/bin/codex-jev"
    link(plugin / "bin/codex-with-jev", launcher)
    desktop_environment(args.home, launcher)
    print(f"Installed fast-jev-compaction at {plugin}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--desktop-resources", type=Path, default=Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli"))
    parser.add_argument("--node", type=Path, default=Path.home() / ".nvm/versions/node/v22.22.2/bin/node")
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args()
    try:
        install(args)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Installation failed: {error}\n")


if __name__ == "__main__":
    main()
