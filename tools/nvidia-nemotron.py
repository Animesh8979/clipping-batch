import os
from openai import OpenAI

api_key = os.environ.get("NVIDIA_API_KEY_4", "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")

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = api_key
)

try:
    completion = client.chat.completions.create(
      model="nvidia/nemotron-3-super-120b-a12b",
      messages=[{"role":"user","content":"Hello Nemotron!"}],
      temperature=1,
      top_p=0.95,
      max_tokens=16384,
      extra_body={"chat_template_kwargs":{"enable_thinking":True},"reasoning_budget":16384},
      stream=True
    )

    for chunk in completion:
      if not chunk.choices:
        continue
      reasoning = getattr(chunk.choices[0].delta, "reasoning_content", None)
      if reasoning:
        print(reasoning, end="")
      if chunk.choices[0].delta.content is not None:
        print(chunk.choices[0].delta.content, end="")
except Exception as e:
    print(f"Error calling Nvidia API: {e}")
