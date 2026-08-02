import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = "/opt/equaxis"
EXTENSIONS = (
    "provider.ts",
    "reliability-harness.ts",
    "memory.ts",
    "web-crawler.ts",
    "tool-catalog.ts",
    "tool-scheduler.ts",
)


class Equaxis(Pi):
    """Run the local Equaxis runtime as an installed Harbor CLI agent."""

    _OUTPUT_FILENAME = "equaxis.jsonl"

    @staticmethod
    @override
    def name() -> str:
        return "equaxis"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await environment.exec(
            command=(
                f"mkdir -p {RUNTIME_ROOT}/.pi {RUNTIME_ROOT}/vendor/agent-memory"
            ),
            user="root",
        )
        for directory in ("src", "bridge", "scripts"):
            await environment.upload_dir(
                PROJECT_ROOT / directory,
                f"{RUNTIME_ROOT}/{directory}",
            )
        await environment.upload_dir(
            PROJECT_ROOT / ".pi" / "extensions",
            f"{RUNTIME_ROOT}/.pi/extensions",
        )
        await environment.upload_dir(
            PROJECT_ROOT / "vendor" / "agent-memory" / "memory",
            f"{RUNTIME_ROOT}/vendor/agent-memory/memory",
        )
        for filename in ("pyproject.toml", "README.md"):
            await environment.upload_file(
                PROJECT_ROOT / "vendor" / "agent-memory" / filename,
                f"{RUNTIME_ROOT}/vendor/agent-memory/{filename}",
            )
        for filename in ("package.json", "package-lock.json"):
            await environment.upload_file(
                PROJECT_ROOT / filename,
                f"{RUNTIME_ROOT}/{filename}",
            )

        await self.exec_as_root(
            environment,
            command=(
                "command -v curl >/dev/null 2>&1 || "
                "(apt-get update && apt-get install -y curl); "
                "command -v python3 >/dev/null 2>&1 || "
                "(apt-get update && apt-get install -y python3 python3-pip); "
                "python3 -m pip --version >/dev/null 2>&1 || "
                "(apt-get update && apt-get install -y python3-pip)"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "if ! command -v node >/dev/null 2>&1; then "
                f"{nvm_node_install_snippet()}; "
                "fi; "
                f"cd {RUNTIME_ROOT} && npm ci --omit=dev && "
                "python3 -m pip install --break-system-packages --upgrade "
                "pip setuptools wheel && "
                "python3 -m pip install --break-system-packages "
                "-e ./vendor/agent-memory"
            ),
            timeout_sec=600,
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model_name = self.model_name or "openai-inprior/gpt-5.5"
        if "/" not in model_name:
            raise ValueError("Model name must use provider/model format")
        provider, model = model_name.split("/", 1)
        if provider != "openai-inprior":
            raise ValueError(
                "The Equaxis Harbor adapter currently supports "
                "openai-inprior models only"
            )

        api_key = self._get_env("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required to run Equaxis in Harbor")

        extension_args = " ".join(
            f"--extension {shlex.quote(f'{RUNTIME_ROOT}/.pi/extensions/{name}')}"
            for name in EXTENSIONS
        )
        resume_flag = "--continue " if self._resume else ""
        escaped_instruction = shlex.quote(instruction)
        output_path = f"/logs/agent/{self._OUTPUT_FILENAME}"
        trace_path = "/logs/agent/equaxis-harness-traces.jsonl"

        command = (
            'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; '
            "mkdir -p /logs/agent/equaxis-sessions /app/.pi/runtime; "
            "cd /app; "
            f"{RUNTIME_ROOT}/node_modules/.bin/pi "
            "--print --mode json "
            "--session-dir /logs/agent/equaxis-sessions "
            f"{resume_flag}"
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            "--thinking xhigh --equaxis-mode enforce "
            f"{extension_args} {escaped_instruction} "
            f"2>&1 | grep -v '\"type\":\"message_update\"' | "
            f"stdbuf -oL tee {shlex.quote(output_path)}; "
            "agent_status=${PIPESTATUS[0]}; "
            f"if [ -f /app/.pi/runtime/traces.jsonl ]; then cp /app/.pi/runtime/traces.jsonl {trace_path}; fi; "
            "exit $agent_status"
        )
        await self.exec_as_agent(
            environment,
            command=command,
            env={"OPENAI_API_KEY": api_key},
        )


class PiControl(Equaxis):
    """Raw Pi control using the same install, model, provider, and task image."""

    _OUTPUT_FILENAME = "pi-control.jsonl"

    @staticmethod
    @override
    def name() -> str:
        return "pi-control"

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model_name = self.model_name or "openai-inprior/gpt-5.5"
        if "/" not in model_name:
            raise ValueError("Model name must use provider/model format")
        provider, model = model_name.split("/", 1)
        if provider != "openai-inprior":
            raise ValueError("PiControl supports openai-inprior models only")
        api_key = self._get_env("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required to run PiControl")

        output_path = f"/logs/agent/{self._OUTPUT_FILENAME}"
        command = (
            'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; '
            "mkdir -p /logs/agent/pi-control-sessions; cd /app; "
            f"{RUNTIME_ROOT}/node_modules/.bin/pi --print --mode json "
            "--session-dir /logs/agent/pi-control-sessions "
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            "--thinking xhigh "
            f"--extension {RUNTIME_ROOT}/.pi/extensions/provider.ts "
            f"{shlex.quote(instruction)} 2>&1 | "
            f"grep -v '\"type\":\"message_update\"' | stdbuf -oL tee {output_path}; "
            "exit ${PIPESTATUS[0]}"
        )
        await self.exec_as_agent(
            environment, command=command, env={"OPENAI_API_KEY": api_key}
        )
