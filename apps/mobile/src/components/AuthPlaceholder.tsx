import { ScreenPlaceholder } from './ScreenPlaceholder';

interface AuthPlaceholderProps {
  title: string;
  description: string;
}

export function AuthPlaceholder({ title, description }: AuthPlaceholderProps) {
  return <ScreenPlaceholder title={title} description={description} />;
}
