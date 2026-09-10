# remote-skills

Async Python client for discovering and activating verified Remote Skills artifacts.

```python
from remote_skills import Origin, RemoteSkills

client = RemoteSkills(
    origins={"acme": Origin(url="https://skills.example.com")}
)

async with client.session("acme") as session:
    skill = await session.activate("code-review")
    print(skill.instructions)
```

Remote Skills treats downloaded instructions and resources as untrusted data. It
verifies artifact bytes but never executes skill content.

Licensed under Apache-2.0.
