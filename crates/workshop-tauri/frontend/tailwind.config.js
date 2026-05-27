/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0a0f",
          1: "#12121a",
          2: "#1a1a25",
          3: "#222230",
        },
        accent: {
          DEFAULT: "#d97706",
          light: "#f59e0b",
          dim: "#b45309",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
