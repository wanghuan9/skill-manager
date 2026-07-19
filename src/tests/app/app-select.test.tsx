import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSelect } from "@/app/components/AppSelect";

const OPTIONS = [
  { value: "all", label: "全部 (3)" },
  { value: "enabled", label: "已启用 (2)" },
  { value: "disabled", label: "未启用 (1)" },
] as const;

function SelectHarness() {
  const [value, setValue] = useState<(typeof OPTIONS)[number]["value"]>("all");
  return (
    <AppSelect
      ariaLabel="状态筛选"
      value={value}
      options={OPTIONS}
      onChange={setValue}
    />
  );
}

test("opens the menu below its trigger and selects an option", async () => {
  const user = userEvent.setup();
  render(<SelectHarness />);

  const trigger = screen.getByRole("combobox", { name: "状态筛选" });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    x: 120,
    y: 40,
    top: 40,
    right: 320,
    bottom: 80,
    left: 120,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  });

  await user.click(trigger);

  const listbox = screen.getByRole("listbox", { name: "状态筛选" });
  expect(listbox).toHaveStyle({ top: "86px", left: "120px", width: "200px" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("option", { name: "未启用 (1)" }));

  expect(trigger).toHaveAttribute("data-value", "disabled");
  expect(trigger).toHaveTextContent("未启用 (1)");
  expect(screen.queryByRole("listbox", { name: "状态筛选" })).not.toBeInTheDocument();
});

test("supports keyboard navigation and escape", async () => {
  const user = userEvent.setup();
  render(<SelectHarness />);

  const trigger = screen.getByRole("combobox", { name: "状态筛选" });
  trigger.focus();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

  expect(trigger).toHaveAttribute("data-value", "enabled");

  await user.keyboard("{Enter}{Escape}");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("keeps compact control menus wide enough for option labels", async () => {
  const user = userEvent.setup();
  render(
    <AppSelect
      ariaLabel="状态筛选"
      value="all"
      options={OPTIONS}
      minMenuWidth={96}
      onChange={vi.fn()}
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "状态筛选" });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    x: 120,
    y: 40,
    top: 40,
    right: 224,
    bottom: 76,
    left: 120,
    width: 104,
    height: 36,
    toJSON: () => ({}),
  });

  await user.click(trigger);

  expect(screen.getByRole("listbox", { name: "状态筛选" })).toHaveStyle({ width: "104px" });
});
