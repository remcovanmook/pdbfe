import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("embeddings.csv")
colors = {"fac": "#e74c3c", "net": "#3498db", "ix": "#2ecc71", "org": "#f39c12", "campus": "#9b59b6", "carrier": "#1abc9c"}

fig, ax = plt.subplots(figsize=(16, 12))
for entity, group in df.groupby("entity"):
    ax.scatter(group["x"], group["y"], c=colors.get(entity, "#aaa"), s=2, alpha=0.5, label=entity)
ax.legend()
plt.savefig("graph_space.png", dpi=150, bbox_inches="tight")
print("saved graph_space.png")
# Add to viz_embeddings.py or run interactively
fig, ax = plt.subplots(figsize=(16, 12))
for entity, group in df[df.entity != "org"].groupby("entity"):
    ax.scatter(group["x"], group["y"], c=colors.get(entity, "#aaa"), s=4, alpha=0.6, label=entity)
ax.legend()
plt.savefig("graph_space_no_org.png", dpi=150, bbox_inches="tight")
