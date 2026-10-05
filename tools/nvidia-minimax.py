import os
from openai import OpenAI

api_key = os.environ.get("NVIDIA_API_KEY_4", "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")

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = api_key
)

try:
    completion = client.chat.completions.create(
      model="minimaxai/minimax-m2.7",
      messages=[{"role":"user","content":"Hello from MiniMax!"}],
      temperature=1,
      top_p=0.95,
      max_tokens=8192,
      stream=False
    )

    print(completion.choices[0].message.content)
except Exception as e:
    print(f"Error calling Nvidia API: {e}")
