"use strict";
document.getElementById("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button"), error = document.getElementById("error");
  button.disabled = true; error.textContent = "";
  try {
    const response = await fetch("/api/auth/token", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({username:document.getElementById("email").value, password:document.getElementById("password").value})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Sign in failed");
    window.location.assign("/dashboard");
  } catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
});
