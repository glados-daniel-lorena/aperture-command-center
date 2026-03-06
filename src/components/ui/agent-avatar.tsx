'use client'

import { useState } from 'react'

interface AgentAvatarProps {
  name: string
  size?: 'xs' | 'sm' | 'md'
  avatarUrl?: string
  className?: string
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase()
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

function getAvatarColors(name: string): { backgroundColor: string; color: string } {
  const hash = hashString(name.toLowerCase())
  const hue = hash % 360
  return {
    backgroundColor: `hsl(${hue} 70% 38%)`,
    color: 'hsl(0 0% 98%)',
  }
}

const sizeClasses: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  xs: 'w-5 h-5 text-[10px]',
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-xs',
}

export function AgentAvatar({ name, size = 'sm', avatarUrl, className = '' }: AgentAvatarProps) {
  const [imgError, setImgError] = useState(false)
  const initials = getInitials(name)
  const colors = getAvatarColors(name)

  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        title={name}
        className={`rounded-full object-cover shrink-0 ${sizeClasses[size]} ${className}`}
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <div
      className={`rounded-full flex items-center justify-center font-semibold shrink-0 ${sizeClasses[size]} ${className}`}
      style={colors}
      title={name}
      aria-label={name}
    >
      {initials}
    </div>
  )
}
