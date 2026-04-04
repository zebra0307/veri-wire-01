import { createClient } from "@/utils/supabase/server";

export default async function TodosPage() {
  const supabase = createClient();
  const { data: todos, error } = await supabase.from("todos").select();

  if (error) {
    return <p>Failed to load todos: {error.message}</p>;
  }

  return (
    <ul>
      {todos?.map((todo: { id: string | number; name: string }) => (
        <li key={todo.id}>{todo.name}</li>
      ))}
    </ul>
  );
}
