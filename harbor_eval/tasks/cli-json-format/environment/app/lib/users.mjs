import fs from "node:fs";

export function loadUsers(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map((line) => {
    const [name, status] = line.split(",");
    return { name, status };
  });
}

export function summarize(users) {
  const activeUsers = users.filter((user) => user.status === "active");
  return { total: users.length, active: activeUsers.length, names: activeUsers.map((user) => user.name) };
}
