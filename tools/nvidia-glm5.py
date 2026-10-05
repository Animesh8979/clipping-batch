import os
import sys
from openai import OpenAI

_USE_COLOR = sys.stdout.isatty() and os.getenv("NO_COLOR") is None
_REASONING_COLOR = "\033[90m" if _USE_COLOR else ""
_RESET_COLOR = "\033[0m" if _USE_COLOR else ""

api_key = os.environ.get("NVIDIA_API_KEY_3", "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")

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = api_key
)

try:
    completion = client.chat.completions.create(
      model="z-ai/glm-5.1",
      messages=[{"role":"user","content":"Hello, GLM!"}],
      temperature=1,
      top_p=1,
      max_tokens=16384,
      stream=True
    )

    for chunk in completion:
      if not getattr(chunk, "choices", None):
        continue
      if len(chunk.choices) == 0 or getattr(chunk.choices[0], "delta", None) is None:
        continue
      delta = chunk.choices[0].delta
      if getattr(delta, "content", None) is not None:
        print(delta.content, end="")
except Exception as e:
    print(f"Error calling Nvidia API: {e}")
