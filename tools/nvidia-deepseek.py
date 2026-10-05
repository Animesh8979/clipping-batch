import os
from openai import OpenAI

# Load the key from the environment, fallback to the provided string
api_key = os.environ.get("NVIDIA_API_KEY_3", "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")

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = api_key
)

try:
    completion = client.chat.completions.create(
      model="deepseek-ai/deepseek-v4-pro",
      messages=[{"role":"user","content":"Explain how to build a sports highlight video."}],
      temperature=1,
      top_p=0.95,
      max_tokens=16384,
      extra_body={"chat_template_kwargs":{"thinking":False}},
      stream=False
    )
    
    print(completion.choices[0].message.content)
except Exception as e:
    print(f"Error calling Nvidia API: {e}")
